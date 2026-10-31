-- Добровольное удаление собственного пользователя. Выполнять после family_plan.
-- Учётная запись Auth и связанные личные данные удаляются одной транзакцией.
begin;
create schema if not exists account_api;
revoke all on schema account_api from public,anon;
grant usage on schema account_api to authenticated;

-- Автор может уйти, не удаляя общий план и введённые им общие расходы.
alter table public.accounts alter column created_by drop not null;
alter table public.accounts drop constraint if exists accounts_created_by_fkey;
alter table public.accounts add constraint accounts_created_by_fkey foreign key(created_by) references auth.users(id) on delete set null;
alter table public.expense_facts drop constraint if exists expense_facts_entered_by_fkey;
alter table public.expense_facts add constraint expense_facts_entered_by_fkey foreign key(entered_by) references auth.users(id) on delete set null;
alter table public.family_contributions alter column source_account_id drop not null;
alter table public.family_contributions drop constraint if exists family_contributions_source_account_id_fkey;
alter table public.family_contributions add constraint family_contributions_source_account_id_fkey foreign key(source_account_id) references public.accounts(id) on delete set null;
alter table public.family_invitations alter column created_by drop not null;

create or replace function account_api.require_user()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); begin
  if uid is null or not exists(select 1 from auth.users where id=uid) then
    raise sqlstate 'PT401' using message='Нужно войти в действующий аккаунт';
  end if;
  return uid;
end $$;

create or replace function account_api.deletion_preview()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=account_api.require_user(); plans jsonb; family jsonb; result jsonb; begin
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,
    'delete',not exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id<>uid),
    'blocked',exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid and m.role='owner')
      and exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id<>uid)
      and not exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id<>uid and m.role='owner'),
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'role',m.role) order by m.user_id),'[]')
      from public.account_members m where m.account_id=a.id),
    'recipients',case when exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid and m.role='owner')
      then (select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'email',u.email) order by m.user_id),'[]')
        from public.account_members m join auth.users u on u.id=m.user_id where m.account_id=a.id and m.user_id<>uid)
      else '[]'::jsonb end) order by a.id),'[]') into plans
  from public.accounts a where a.plan_kind='personal' and (exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid)
    or a.created_by=uid and not exists(select 1 from public.account_members m where m.account_id=a.id));
  select jsonb_build_object('id',f.id,'title',a.title,
    'last_member',not exists(select 1 from public.family_members x where x.family_id=f.id and x.active and x.user_id is distinct from uid),
    'members',(select jsonb_agg(x.id order by x.id) from public.family_members x where x.family_id=f.id and x.active)) into family
    from public.family_members m join public.families f on f.id=m.family_id join public.accounts a on a.id=f.id
    where m.user_id=uid and m.active;
  result:=jsonb_build_object('plans',(select coalesce(jsonb_agg(x-'members'),'[]') from jsonb_array_elements(plans) x),
    'family',family-'members','version',md5(jsonb_build_object('plans',plans,'family',family)::text));
  return result;
end $$;

-- Владелец явно выбирает уже существующего участника обычного общего плана.
create or replace function account_api.assign_owner(p_account uuid,p_user uuid)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=account_api.require_user(); begin
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform 1 from public.accounts where id=p_account and plan_kind='personal' for update;
  if not found or not exists(select 1 from public.account_members where account_id=p_account and user_id=uid and role='owner') then
    raise sqlstate 'PT403' using message='Назначить владельца может только владелец личного плана';
  end if;
  if p_user=uid or not exists(select 1 from public.account_members where account_id=p_account and user_id=p_user) then
    raise sqlstate 'PT400' using message='Выберите другого существующего участника плана';
  end if;
  update public.account_members set role='owner' where account_id=p_account and user_id=p_user;
end $$;

create or replace function account_api.redact_actor(value jsonb,uid uuid,email text,member_ids uuid[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare key text; begin
  if value is null then return null; end if;
  foreach key in array array['user_id','created_by','accepted_by','actor_id'] loop
    if value->>key=uid::text then value:=jsonb_set(value,array[key],'null'::jsonb); end if;
  end loop;
  if lower(value->>'email')=lower(email) or value->>'id'=any(member_ids::text[]) then
    value:=value-'email'||jsonb_build_object('nickname','Удалённый участник');
  end if;
  return value;
end $$;

create or replace function account_api.delete_self(p_confirmation text,p_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=account_api.require_user(); preview jsonb; v_email text; member_ids uuid[]; plan_ids uuid[]; f uuid; begin
  if upper(btrim(coalesce(p_confirmation,'')))<>'УДАЛИТЬ' then
    raise sqlstate 'PT400' using message='Для подтверждения введите УДАЛИТЬ';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform 1 from auth.users where id=uid for update;
  perform 1 from public.families where id in(select family_id from public.family_members where user_id=uid) order by id for update;
  perform 1 from public.accounts a where a.created_by=uid or exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid) order by a.id for update;
  perform 1 from public.account_members m where m.account_id in(select account_id from public.account_members where user_id=uid) order by m.account_id,m.user_id for update;
  preview:=account_api.deletion_preview();
  if p_version is distinct from preview->>'version' then raise sqlstate 'PT409' using message='Состав планов изменился. Проверьте условия удаления ещё раз'; end if;
  if exists(select 1 from jsonb_array_elements(preview->'plans') x where (x->>'blocked')::boolean) then
    raise sqlstate 'PT409' using message='Сначала назначьте другого владельца общих планов';
  end if;
  select u.email into v_email from auth.users u where id=uid;
  select coalesce(array_agg(m.id),'{}') into member_ids from public.family_members m where user_id=uid;
  select coalesce(array_agg((x->>'id')::uuid),'{}') into plan_ids from jsonb_array_elements(preview->'plans') x where (x->>'delete')::boolean;

  -- Прогноз прекращается; сумма и месяцы проведённых взносов остаются семье.
  delete from public.family_contributions where status='forecast' and (member_id=any(member_ids) or source_account_id=any(plan_ids));
  delete from public.family_contribution_rules where member_id=any(member_ids);
  delete from public.family_contribution_overrides where member_id=any(member_ids);
  update public.family_members set active=false,left_at=coalesce(left_at,now()),revision=revision+1,
    user_id=null,email='',nickname='Удалённый участник',color='blue',source_account_id=null where id=any(member_ids);
  update public.family_contributions set available_before=0,ledger_after='{}' where member_id=any(member_ids);
  update public.family_members set source_account_id=null,revision=revision+1 where source_account_id=any(plan_ids);
  update public.family_contributions set source_account_id=null,available_before=0,ledger_after='{}' where source_account_id=any(plan_ids);
  for f in select distinct m.family_id from public.family_members m where m.id=any(member_ids) loop
    if not exists(select 1 from public.family_members where family_id=f and active) then
      update public.families set deleted_at=coalesce(deleted_at,now()),version=version+1 where id=f;
      update public.family_invitations set status='revoked' where family_id=f and status='pending';
      delete from family_api.mail_outbox where invitation_id in(select id from public.family_invitations where family_id=f);
    else update public.families set version=version+1 where id=f;
    end if;
  end loop;

  delete from family_api.mail_outbox where invitation_id in(select id from public.family_invitations where lower(public.family_invitations.email)=lower(v_email) or accepted_by=uid);
  delete from public.family_invitations where lower(public.family_invitations.email)=lower(v_email) or accepted_by=uid;
  update public.family_invitations set created_by=null where created_by=uid;
  update public.family_audit set actor_id=case when actor_id=uid then null else actor_id end,
    actor_name=case when actor_id=uid then 'Удалённый участник' else actor_name end,
    before_data=account_api.redact_actor(before_data,uid,v_email,member_ids),
    after_data=account_api.redact_actor(after_data,uid,v_email,member_ids)
    where actor_id=uid or object_type='family_members' and object_id=any(member_ids::text[])
      or lower(before_data->>'email')=lower(v_email) or lower(after_data->>'email')=lower(v_email)
      or before_data->>'created_by'=uid::text or after_data->>'created_by'=uid::text
      or before_data->>'accepted_by'=uid::text or after_data->>'accepted_by'=uid::text;
  delete from family_api.requests where user_id=uid;
  update family_api.requests set payload=jsonb_set(payload,'{data,email}','null'::jsonb)
    where lower(payload#>>'{data,email}')=lower(v_email);
  delete from public.client_logs where user_id=uid;
  delete from public.account_members where user_id=uid;
  delete from public.accounts where id=any(plan_ids);
  -- auth.users FK удаляет сессии, refresh-токены и собственные настройки.
  -- Старый JWT не получает доступ: участия удалены, новый вход проверяет Auth.
  delete from auth.users where id=uid;
  return jsonb_build_object('deleted',true);
end $$;

create or replace function public.account_deletion_preview()
returns jsonb language sql set search_path='' as $$select account_api.deletion_preview();$$;
create or replace function public.account_assign_owner(p_account uuid,p_user uuid)
returns void language sql set search_path='' as $$select account_api.assign_owner(p_account,p_user);$$;
create or replace function public.delete_my_account(p_confirmation text,p_version text)
returns jsonb language sql set search_path='' as $$select account_api.delete_self(p_confirmation,p_version);$$;
revoke all on all functions in schema account_api from public,anon,authenticated;
grant execute on function account_api.deletion_preview(),account_api.assign_owner(uuid,uuid),account_api.delete_self(text,text) to authenticated;
revoke all on function public.account_deletion_preview(),public.account_assign_owner(uuid,uuid),public.delete_my_account(text,text) from public,anon;
grant execute on function public.account_deletion_preview(),public.account_assign_owner(uuid,uuid),public.delete_my_account(text,text) to authenticated;
notify pgrst,'reload schema';
commit;
