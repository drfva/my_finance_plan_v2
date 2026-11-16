alter table expense_tracking.plans add column if not exists income_tracking_from date;
-- Existing opening/current balances may already include today's receipt.
update expense_tracking.plans set income_tracking_from=(now() at time zone 'Europe/Moscow')::date+1
  where income_tracking_from is null;
alter table expense_tracking.plans alter column income_tracking_from set not null,
  alter column income_tracking_from set default ((now() at time zone 'Europe/Moscow')::date);

create table if not exists expense_tracking.income_receipts (
  plan_id uuid not null,
  period_id text not null,
  account_id uuid not null,
  paid_on date,
  amount numeric check (amount between 0 and 99999999999999 and amount=round(amount,2)),
  title text,
  primary key (plan_id, period_id),
  foreign key (plan_id, account_id) references expense_tracking.accounts(plan_id,id) on delete cascade,
  check ((paid_on is null and amount is null and title is null) or
         (paid_on is not null and amount is not null and title is not null))
);
create index if not exists expense_income_receipts_by_account on expense_tracking.income_receipts(plan_id,account_id);
create table if not exists expense_tracking.income_account_changes (
  id bigint generated always as identity primary key,
  plan_id uuid not null references expense_tracking.plans(id) on delete cascade,
  period_id text not null,
  changed_at timestamptz not null default now(),
  from_account uuid not null,
  to_account uuid not null
);
create index if not exists expense_income_changes_by_plan on expense_tracking.income_account_changes(plan_id,id desc);
alter table expense_tracking.income_receipts enable row level security;
alter table expense_tracking.income_account_changes enable row level security;
revoke all on expense_tracking.income_receipts, expense_tracking.income_account_changes from public, anon, authenticated;

create or replace function public.expense_tracking_get(p_plan uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb := expense_tracking.expense_tracking_get(p_plan);
  accounts jsonb;
  today date := (now() at time zone 'Europe/Moscow')::date;
begin
  if not (result->>'enabled')::boolean then return result; end if;
  select jsonb_agg(a.value || jsonb_build_object(
    'adjusted_opening_amount', (a.value->>'opening_amount')::numeric + coalesce(c.total,0),
    'balance', (a.value->>'balance')::numeric + coalesce(c.total,0) + coalesce(r.total,0)
  ) order by a.position) into accounts
  from jsonb_array_elements(result->'accounts') with ordinality as a(value,position)
  left join (
    select account_id,sum(delta) total from expense_tracking.balance_corrections
    where plan_id=p_plan and effective_on<=today group by account_id
  ) c on c.account_id=(a.value->>'id')::uuid
  left join (
    select account_id,sum(amount) total from expense_tracking.income_receipts
    where plan_id=p_plan and paid_on<=today group by account_id
  ) r on r.account_id=(a.value->>'id')::uuid;
  return jsonb_set(result,'{accounts}',coalesce(accounts,'[]'::jsonb))
    || jsonb_build_object(
      'corrections',coalesce((select jsonb_agg(to_jsonb(c)-'plan_id' order by c.effective_on desc,c.account_id)
        from expense_tracking.balance_corrections c where c.plan_id=p_plan and c.delta<>0),'[]'::jsonb),
      'income_receipts',coalesce((select jsonb_object_agg(r.period_id,to_jsonb(r)-'plan_id'-'period_id')
        from expense_tracking.income_receipts r where r.plan_id=p_plan),'{}'::jsonb),
      'income_account_changes',coalesce((select jsonb_agg((to_jsonb(c)-'plan_id'-'id') ||
        jsonb_build_object('changed_on',(c.changed_at at time zone 'Europe/Moscow')::date) order by c.id desc)
        from expense_tracking.income_account_changes c where c.plan_id=p_plan),'[]'::jsonb));
end;
$$;

create or replace function public.expense_tracking_set_income_account(p_plan uuid,p_period text,p_account uuid,p_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tracking expense_tracking.plans;
  receipt expense_tracking.income_receipts;
  destination uuid;
begin
  if auth.uid() is null or not public.can_edit_account(p_plan) or not exists(
    select 1 from public.accounts a where a.id=p_plan and a.plan_kind='personal'
  ) then raise sqlstate 'PT403' using message='Нет доступа к выплатам этого плана'; end if;
  select * into tracking from expense_tracking.plans p where p.id=p_plan for update;
  if tracking.id is null or tracking.revision is distinct from p_revision then
    raise sqlstate 'PT409' using message='Учёт изменился. Проверьте счёт выплаты и попробуйте снова.';
  end if;
  select * into receipt from expense_tracking.income_receipts r where r.plan_id=p_plan and r.period_id=p_period;
  if receipt.paid_on is null and not exists(select 1 from public.periods p
    where p.account_id=p_plan and p.id=p_period and p.pay_date>=tracking.income_tracking_from) then
    raise sqlstate 'PT400' using message='Эта выплата находится вне периода учёта зачислений';
  end if;
  destination := case when receipt.paid_on is not null then coalesce(p_account,tracking.deposit_account) else p_account end;
  if destination is not null and not exists(select 1 from expense_tracking.accounts a where a.plan_id=p_plan and a.id=destination) then
    raise sqlstate 'PT400' using message='Выберите счёт этого плана';
  end if;
  if receipt.account_id is distinct from destination then
    if destination is null then
      delete from expense_tracking.income_receipts r where r.plan_id=p_plan and r.period_id=p_period;
    elsif receipt.paid_on is not null then
      update expense_tracking.income_receipts r set account_id=destination where r.plan_id=p_plan and r.period_id=p_period;
      insert into expense_tracking.income_account_changes(plan_id,period_id,from_account,to_account)
        values(p_plan,p_period,receipt.account_id,destination);
    else
      insert into expense_tracking.income_receipts(plan_id,period_id,account_id) values(p_plan,p_period,destination)
        on conflict (plan_id,period_id) do update set account_id=excluded.account_id;
    end if;
    update expense_tracking.plans p set revision=p.revision+1 where p.id=p_plan;
  end if;
  return public.expense_tracking_get(p_plan);
end $$;

create or replace function expense_tracking.due_income_plans()
returns setof uuid language sql stable set search_path='' as $$
  select t.id from expense_tracking.plans t join public.accounts a on a.id=t.id
  where a.plan_kind='personal' and exists (
    select 1 from public.periods p
    where p.account_id=t.id and p.pay_date between t.income_tracking_from and (now() at time zone 'Europe/Moscow')::date
      and not exists(select 1 from expense_tracking.income_receipts r where r.plan_id=t.id and r.period_id=p.id and r.paid_on is not null)
  );
$$;

create or replace function public.expense_income_worker_read(p_plan uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  previous_uid text := current_setting('request.jwt.claim.sub',true);
  first_date date;
  pending jsonb;
  snapshot jsonb;
begin
  select t.income_tracking_from into first_date from expense_tracking.plans t join public.accounts a on a.id=t.id
    where t.id=p_plan and a.plan_kind='personal';
  select m.user_id into actor from public.account_members m
    where m.account_id=p_plan and m.role in ('owner','editor') order by (m.role='owner') desc,m.user_id limit 1;
  if first_date is null or actor is null then return null; end if;
  select jsonb_agg(p.id) into pending from public.periods p
    where p.account_id=p_plan and p.pay_date between first_date and (now() at time zone 'Europe/Moscow')::date
      and not exists(select 1 from expense_tracking.income_receipts r where r.plan_id=p_plan and r.period_id=p.id and r.paid_on is not null);
  if pending is null then return null; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  snapshot := public.state_get(p_plan);
  perform set_config('request.jwt.claim.sub',coalesce(previous_uid,''),true);
  return snapshot || jsonb_build_object('pending_income_receipts',pending);
end $$;

create or replace function public.expense_income_worker_post(p_plan uuid,p_versions jsonb,p_rows jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare
  domain_key text;
  actual_version bigint;
  tracking expense_tracking.plans;
  changes integer;
begin
  foreach domain_key in array array['income','settings'] loop
    insert into public.state_versions(account_id,domain) values(p_plan,domain_key) on conflict do nothing;
    select v.version into actual_version from public.state_versions v where v.account_id=p_plan and v.domain=domain_key for update;
    if actual_version is distinct from (p_versions->>domain_key)::bigint then
      raise sqlstate 'PT409' using message='Доходы или настройки изменились во время расчёта';
    end if;
  end loop;
  select * into tracking from expense_tracking.plans t where t.id=p_plan for update;
  if tracking.id is null or not exists(select 1 from public.accounts a where a.id=p_plan and a.plan_kind='personal') then return 0; end if;
  insert into expense_tracking.income_receipts as receipt(plan_id,period_id,account_id,paid_on,amount,title)
  select p_plan,p.id,coalesce(r.account_id,tracking.deposit_account),p.pay_date,round(s.amount,2),p.title
  from jsonb_to_recordset(p_rows) s(period_id text,amount numeric)
  join public.periods p on p.account_id=p_plan and p.id=s.period_id
  left join expense_tracking.income_receipts r on r.plan_id=p_plan and r.period_id=p.id
  where p.pay_date between tracking.income_tracking_from and (now() at time zone 'Europe/Moscow')::date
    and r.paid_on is null
  on conflict (plan_id,period_id) do update set paid_on=excluded.paid_on,amount=excluded.amount,title=excluded.title
    where receipt.paid_on is null;
  get diagnostics changes=row_count;
  if changes>0 then update expense_tracking.plans p set revision=p.revision+1 where p.id=p_plan; end if;
  return changes;
end $$;

revoke execute on function expense_tracking.due_income_plans() from public, anon, authenticated;
revoke execute on function public.expense_income_worker_read(uuid),public.expense_income_worker_post(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.expense_income_worker_read(uuid),public.expense_income_worker_post(uuid,jsonb,jsonb) to service_role;
revoke execute on function public.expense_tracking_set_income_account(uuid,text,uuid,bigint) from public,anon;
grant execute on function public.expense_tracking_set_income_account(uuid,text,uuid,bigint) to authenticated;
notify pgrst, 'reload schema';
