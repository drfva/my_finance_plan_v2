begin;

-- Shared access can be granted before the first login. Every user still
-- needs an owned personal plan; family membership is not a substitute.
create or replace function public.bootstrap_user(p_title text default 'Мой план')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_account uuid;
begin
  if v_uid is null then
    perform api_private.fail('PT401','Нужно войти в приложение');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bootstrap_user:'||v_uid::text,0));
  select a.id into v_account
    from public.accounts a join public.account_members m on m.account_id=a.id
    where m.user_id=v_uid and m.role='owner' and a.plan_kind='personal'
    order by (a.created_by=v_uid) desc,m.added_at,a.id
    limit 1;
  if v_account is null then
    v_account:=public.create_account(coalesce(nullif(btrim(p_title),''),'Мой план'));
  end if;
  return public.state_get(v_account);
end $$;

revoke all on function public.bootstrap_user(text) from public,anon;
grant execute on function public.bootstrap_user(text) to authenticated;
notify pgrst,'reload schema';
commit;
