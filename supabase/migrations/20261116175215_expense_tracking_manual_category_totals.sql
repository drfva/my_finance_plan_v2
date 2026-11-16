create table if not exists expense_tracking.fact_overrides (
  plan_id uuid not null references public.accounts(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  category_id text not null,
  category_title text not null,
  amount numeric not null check (amount between 0 and 99999999999999 and amount=round(amount,2)),
  primary key (plan_id, month, category_id)
);
alter table expense_tracking.fact_overrides enable row level security;
revoke all on expense_tracking.fact_overrides from public, anon, authenticated;

do $$ begin
  if to_regprocedure('expense_tracking.expense_tracking_get_with_receipts(uuid)') is null then
    alter function public.expense_tracking_get(uuid) rename to expense_tracking_get_with_receipts;
    alter function public.expense_tracking_get_with_receipts(uuid) set schema expense_tracking;
    revoke execute on function expense_tracking.expense_tracking_get_with_receipts(uuid) from public, anon, authenticated;
  end if;
end $$;

create or replace function public.expense_tracking_get(p_plan uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  result := expense_tracking.expense_tracking_get_with_receipts(p_plan);
  return result || jsonb_build_object('fact_overrides',coalesce((
    select jsonb_agg(to_jsonb(f)-'plan_id' order by f.month,f.category_id)
    from expense_tracking.fact_overrides f where f.plan_id=p_plan
  ),'[]'::jsonb));
end $$;

create or replace function public.expense_tracking_set_category_fact(
  p_plan uuid,p_month text,p_category text,p_amount numeric,p_previous numeric
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  plan_kind text;
  actor public.family_members;
  title text;
  before_amount numeric;
begin
  if auth.uid() is null or not public.is_account_member(p_plan) then
    raise sqlstate 'PT403' using message='Нет доступа к плану';
  end if;
  select a.plan_kind into plan_kind from public.accounts a where a.id=p_plan for update;
  if plan_kind='family' then
    actor := family_api.require_member(p_plan,true);
    select c.title into title from public.family_categories c
      where c.family_id=p_plan and c.id=p_category and c.parent_id is null;
  elsif plan_kind='personal' and public.can_edit_account(p_plan) then
    select c.title into title from public.expense_categories c where c.account_id=p_plan and c.id=p_category;
  else
    raise sqlstate 'PT403' using message='Нет доступа к редактированию плана';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or
    p_amount is not null and (p_amount not between 0 and 99999999999999 or p_amount<>round(p_amount,2)) then
    raise sqlstate 'PT400' using message='Проверьте месяц и неотрицательную сумму';
  end if;
  select f.amount into before_amount from expense_tracking.fact_overrides f
    where f.plan_id=p_plan and f.month=p_month and f.category_id=p_category;
  if before_amount is not distinct from p_amount then return public.expense_tracking_get(p_plan); end if;
  if before_amount is distinct from p_previous then
    raise sqlstate 'PT409' using message='Итог категории уже изменился. Проверьте сумму и попробуйте ещё раз.';
  end if;
  if p_amount is null then
    delete from expense_tracking.fact_overrides f where f.plan_id=p_plan and f.month=p_month and f.category_id=p_category;
  else
    if title is null then raise sqlstate 'PT400' using message='Категория плана не найдена'; end if;
    insert into expense_tracking.fact_overrides(plan_id,month,category_id,category_title,amount)
      values(p_plan,p_month,p_category,title,p_amount)
      on conflict (plan_id,month,category_id) do update set category_title=excluded.category_title,amount=excluded.amount;
  end if;
  if plan_kind='family' then
    insert into public.family_audit(family_id,actor_id,actor_name,actor_kind,action,object_type,object_id,before_data,after_data)
      values(p_plan,auth.uid(),coalesce(nullif(actor.nickname,''),actor.email),'user',
        case when before_amount is null then 'INSERT' when p_amount is null then 'DELETE' else 'UPDATE' end,
        'family_fact_override',p_category,
        case when before_amount is not null then jsonb_build_object('month',p_month,'title',title,'amount',before_amount) end,
        case when p_amount is not null then jsonb_build_object('month',p_month,'title',title,'amount',p_amount) end);
  end if;
  update expense_tracking.plans p set revision=p.revision+1 where p.id=p_plan;
  return public.expense_tracking_get(p_plan);
end $$;

revoke execute on function public.expense_tracking_get(uuid),
  public.expense_tracking_set_category_fact(uuid,text,text,numeric,numeric) from public, anon;
grant execute on function public.expense_tracking_get(uuid),
  public.expense_tracking_set_category_fact(uuid,text,text,numeric,numeric) to authenticated;
notify pgrst, 'reload schema';
