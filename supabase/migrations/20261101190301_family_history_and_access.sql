begin;

create index if not exists family_audit_created_at_idx on public.family_audit(created_at);
create or replace function family_api.audit_cutoff()
returns timestamptz language sql stable security invoker set search_path='' as $$
  select ((now() at time zone 'Europe/Moscow') - interval '1 month') at time zone 'Europe/Moscow';
$$;

create or replace function family_api.prune_audit(p_family uuid default null)
returns bigint language plpgsql security invoker set search_path='' as $$
declare removed bigint; begin
  delete from public.family_audit where created_at<family_api.audit_cutoff() and (p_family is null or family_id=p_family);
  get diagnostics removed=row_count;
  return removed;
end $$;

-- Page anchor prevents incoming audit events from shifting existing pages.
create or replace function family_api.history_data(p_family uuid,p_page integer default 1,p_anchor bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  with bounds as (select family_api.audit_cutoff() cutoff,coalesce(p_anchor,
    (select max(id) from public.family_audit where family_id=p_family and created_at>=family_api.audit_cutoff()),0) anchor),
  stats as (select count(*)::integer total from public.family_audit a cross join bounds b
    where a.family_id=p_family and a.created_at>=b.cutoff and a.id<=b.anchor),
  page as (select total,greatest(1,(total+9)/10) pages,least(greatest(1,coalesce(p_page,1)),greatest(1,(total+9)/10)) page from stats)
  select jsonb_build_object('items',coalesce((select jsonb_agg(x order by x.id desc) from (
      select a.* from public.family_audit a cross join bounds b where a.family_id=p_family and a.created_at>=b.cutoff and a.id<=b.anchor
      order by a.id desc limit 10 offset (select (page-1)*10 from page)) x),'[]'),
    'page',p.page,'pages',p.pages,'total',p.total,'anchor',b.anchor)
  from page p cross join bounds b;
$$;

create or replace function family_api.history_page(p_family uuid,p_page integer default 1,p_anchor bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform family_api.require_member(p_family);
  perform family_api.prune_audit(p_family);
  return family_api.history_data(p_family,p_page,p_anchor);
end $$;
create or replace function public.family_history_page(p_family uuid,p_page integer default 1,p_anchor bigint default null)
returns jsonb language sql set search_path='' as $$ select family_api.history_page(p_family,p_page,p_anchor); $$;

-- Keep the old cursor endpoint compatible, with the same retention and size.
create or replace function family_api.history(p_family uuid,p_before bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform family_api.require_member(p_family);
  return (select coalesce(jsonb_agg(x order by x.id desc),'[]') from (
    select a.* from public.family_audit a where a.family_id=p_family and a.created_at>=family_api.audit_cutoff()
      and (p_before is null or a.id<p_before) order by a.id desc limit 10) x);
end $$;

do $migration$
declare definition text; begin
  definition:=replace(pg_get_functiondef('family_api.read(uuid)'::regprocedure),E'\r\n',E'\n');
  if position('family-history-access-v3' in definition)=0 then
    definition:=replace(definition,$old$c.family_id = f.id and (c.amount > 0 or c.member_id=m.id and c.status='forecast')$old$,'c.family_id = f.id');
    -- Match a single line: SQL Editor may paste CRLF while the stored
    -- function definition above has already been normalized to LF.
    definition:=replace(definition,$old$'audit', (select coalesce(jsonb_agg(x order by x.id desc),'[]') from (select au.* from public.family_audit au where au.family_id = f.id order by au.id desc limit 200) x),$old$,
      $new$'audit', '[]'::jsonb,$new$);
    definition:=replace(definition,'  return result || jsonb_build_object(', $code$
  -- family-history-access-v3
  result:=result || (select jsonb_build_object('audit',h->'items','audit_page',h->'page','audit_pages',h->'pages','audit_total',h->'total','audit_anchor',h->'anchor')
    from (select family_api.history_data(p_family,1,null) h) history);
  return result || jsonb_build_object($code$);
    if position('family-history-access-v3' in definition)=0 or position('limit 200' in definition)>0 then raise exception 'Не удалось обновить семейную историю'; end if;
    execute definition;
  end if;
  definition:=replace(pg_get_functiondef('family_api.command(text,uuid,jsonb,bigint,uuid)'::regprocedure),E'\r\n',E'\n');
  if position('family-history-access-v3' in definition)=0 then
    definition:=replace(definition,$old$    if p_action in ('category','delete_category','expense','allocation','reset_allocations') then$old$,$code$
    -- family-history-access-v3
    perform family_api.prune_audit(p_family);
    if p_action in ('category','delete_category','expense','allocation','reset_allocations') then$code$);
    definition:=replace(definition,$old$        if contribution.status='posted'$old$,$code$
        if contribution.member_id<>m.id then
          raise sqlstate 'PT403' using message='Можно изменять только распределение своих взносов';
        end if;
        if contribution.status='posted'$code$);
    if position('contribution.member_id<>m.id' in definition)=0 then raise exception 'Не удалось ограничить редактирование распределения'; end if;
    execute definition;
  end if;
  definition:=replace(pg_get_functiondef('family_api.mail_claim(uuid)'::regprocedure),E'\r\n',E'\n');
  if position('family_api.prune_audit' in definition)=0 then
    definition:=replace(definition,'  for r in select',$code$  perform family_api.prune_audit();
  for r in select$code$);
    if position('family_api.prune_audit' in definition)=0 then raise exception 'Не удалось включить очистку истории в серверную задачу'; end if;
    execute definition;
  end if;
end $migration$;

revoke all on function family_api.audit_cutoff(),family_api.prune_audit(uuid),family_api.history_data(uuid,integer,bigint) from public,anon,authenticated,service_role;
revoke all on function public.family_history_page(uuid,integer,bigint) from public,anon,service_role;
revoke all on function family_api.history_page(uuid,integer,bigint) from public,anon,service_role;
grant execute on function family_api.history_page(uuid,integer,bigint) to authenticated;
grant execute on function public.family_history_page(uuid,integer,bigint) to authenticated;
select family_api.prune_audit();

-- Supabase Cron is already used for family payments. Idle families are
-- cleaned as well; without Cron, reads and worker activity enforce retention.
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('family-audit-retention','17 * * * *','select family_api.prune_audit();');
  end if;
end $$;
notify pgrst,'reload schema';
commit;
