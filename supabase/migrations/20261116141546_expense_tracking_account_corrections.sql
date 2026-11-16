create table if not exists expense_tracking.balance_corrections (
  plan_id uuid not null,
  account_id uuid not null,
  effective_on date not null,
  delta numeric not null,
  primary key (plan_id, account_id, effective_on),
  foreign key (plan_id, account_id) references expense_tracking.accounts(plan_id, id) on delete cascade
);
alter table expense_tracking.balance_corrections enable row level security;
revoke all on expense_tracking.balance_corrections from public, anon, authenticated;

do $$
begin
  if to_regprocedure('expense_tracking.expense_tracking_get(uuid)') is null then
    alter function public.expense_tracking_get(uuid) set schema expense_tracking;
    revoke execute on function expense_tracking.expense_tracking_get(uuid) from public, anon, authenticated;
  end if;
  if to_regprocedure('expense_tracking.expense_tracking_command(uuid,text,jsonb,bigint)') is null then
    alter function public.expense_tracking_command(uuid,text,jsonb,bigint) set schema expense_tracking;
    revoke execute on function expense_tracking.expense_tracking_command(uuid,text,jsonb,bigint) from public, anon, authenticated;
  end if;
end;
$$;

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
    'adjusted_opening_amount', (a.value->>'opening_amount')::numeric + coalesce(c.total, 0),
    'balance', (a.value->>'balance')::numeric + coalesce(c.total, 0)
  ) order by a.position)
  into accounts
  from jsonb_array_elements(result->'accounts') with ordinality as a(value,position)
  left join lateral (
    select sum(delta) total from expense_tracking.balance_corrections
      where plan_id=p_plan and account_id=(a.value->>'id')::uuid and effective_on<=today
  ) c on true;
  return jsonb_set(result,'{accounts}',coalesce(accounts,'[]'::jsonb))
    || jsonb_build_object('corrections',coalesce((
      select jsonb_agg(to_jsonb(c) - 'plan_id' order by c.effective_on desc,c.account_id)
      from expense_tracking.balance_corrections c where c.plan_id=p_plan and c.delta<>0
    ),'[]'::jsonb));
end;
$$;

create or replace function public.expense_tracking_command(
  p_plan uuid, p_action text, p_payload jsonb, p_revision bigint default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  today date := (now() at time zone 'Europe/Moscow')::date;
  target uuid;
  new_title text;
  requested numeric;
  previous numeric;
  revision bigint;
  is_family boolean;
begin
  if p_action is distinct from 'account_edit' then
    return expense_tracking.expense_tracking_command(p_plan,p_action,p_payload,p_revision);
  end if;
  if auth.uid() is null or not public.is_account_member(p_plan) then
    raise exception using errcode='42501',message='Нет доступа к редактированию плана';
  end if;
  select plan_kind='family' into is_family from public.accounts where id=p_plan for update;
  if is_family then
    perform family_api.require_member(p_plan,true);
  elsif not public.can_edit_account(p_plan) then
    raise exception using errcode='42501',message='Нет доступа к редактированию плана';
  end if;
  select p.revision into revision from expense_tracking.plans p where p.id=p_plan;
  if revision is null or revision is distinct from p_revision then
    raise exception using errcode='PT409',message='Учет изменился в другой вкладке. Обновите данные.';
  end if;
  target := (p_payload->>'id')::uuid;
  new_title := btrim(p_payload->>'title');
  requested := (p_payload->>'amount')::numeric;
  if new_title is null or length(new_title) not between 1 and 160
    or requested is null or abs(requested)>99999999999999 or requested<>round(requested,2) then
    raise exception 'Проверьте название и сумму начального остатка';
  end if;
  select a.opening_amount + coalesce((
    select sum(delta) from expense_tracking.balance_corrections
      where plan_id=p_plan and account_id=target and effective_on<=today
  ),0) into previous from expense_tracking.accounts a where (a.plan_id,a.id)=(p_plan,target);
  if previous is null then raise exception 'Счет не найден'; end if;
  update expense_tracking.accounts set title=new_title where (plan_id,id)=(p_plan,target);
  if previous<>requested then
    insert into expense_tracking.balance_corrections as c values (p_plan,target,today,requested-previous)
      on conflict (plan_id,account_id,effective_on) do update set delta=c.delta+excluded.delta;
  end if;
  update expense_tracking.plans p set revision=p.revision+1 where p.id=p_plan;
  return public.expense_tracking_get(p_plan);
end;
$$;

revoke execute on function public.expense_tracking_get(uuid),
  public.expense_tracking_command(uuid,text,jsonb,bigint) from public, anon;
grant execute on function public.expense_tracking_get(uuid),
  public.expense_tracking_command(uuid,text,jsonb,bigint) to authenticated;
