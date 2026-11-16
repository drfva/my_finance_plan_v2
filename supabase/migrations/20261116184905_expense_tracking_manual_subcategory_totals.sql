do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='expense_tracking'
    and table_name='fact_overrides' and column_name='item_id') then
    alter table expense_tracking.fact_overrides
      add column item_id text not null default '',
      add column item_title text not null default '',
      drop constraint fact_overrides_pkey,
      add primary key (plan_id,month,category_id,item_id);
  end if;
end $$;

create or replace function public.expense_tracking_get(p_plan uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  result := expense_tracking.expense_tracking_get_with_receipts(p_plan);
  return result || jsonb_build_object('fact_items_supported',true,'fact_overrides',coalesce((
    select jsonb_agg(to_jsonb(f)-'plan_id' order by f.month,f.category_id,f.item_id)
    from expense_tracking.fact_overrides f where f.plan_id=p_plan
  ),'[]'::jsonb));
end $$;

create or replace function public.expense_tracking_set_category_fact(
  p_plan uuid,p_month text,p_category text,p_amount numeric,p_previous numeric,p_item text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  plan_kind text;
  actor public.family_members;
  title text;
  item text := coalesce(p_item,'');
  item_title text;
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
    if item<>'' then
      select c.title into item_title from public.family_categories c
        where c.family_id=p_plan and c.id=item and c.parent_id=p_category;
    end if;
  elsif plan_kind='personal' and public.can_edit_account(p_plan) then
    select c.title into title from public.expense_categories c where c.account_id=p_plan and c.id=p_category;
    if item<>'' then
      select i.title into item_title from public.expense_items i where i.account_id=p_plan and i.id=item and i.category_id=p_category;
    end if;
  else
    raise sqlstate 'PT403' using message='Нет доступа к редактированию плана';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or
    p_amount is not null and (p_amount not between 0 and 99999999999999 or p_amount<>round(p_amount,2)) then
    raise sqlstate 'PT400' using message='Проверьте месяц и неотрицательную сумму';
  end if;
  select f.amount into before_amount from expense_tracking.fact_overrides f
    where f.plan_id=p_plan and f.month=p_month and f.category_id=p_category and f.item_id=item;
  if before_amount is not distinct from p_amount then return public.expense_tracking_get(p_plan); end if;
  if before_amount is distinct from p_previous then
    raise sqlstate 'PT409' using message=case when item='' then 'Итог категории уже изменился. Проверьте сумму и попробуйте ещё раз.'
      else 'Сумма подкатегории уже изменилась. Проверьте её и попробуйте ещё раз.' end;
  end if;
  if p_amount is null then
    delete from expense_tracking.fact_overrides f where f.plan_id=p_plan and f.month=p_month and f.category_id=p_category and f.item_id=item;
  else
    if title is null or item<>'' and item_title is null then
      raise sqlstate 'PT400' using message='Категория или подкатегория плана не найдена';
    end if;
    insert into expense_tracking.fact_overrides(plan_id,month,category_id,category_title,item_id,item_title,amount)
      values(p_plan,p_month,p_category,title,item,coalesce(item_title,''),p_amount)
      on conflict (plan_id,month,category_id,item_id) do update set category_title=excluded.category_title,
        item_title=excluded.item_title,amount=excluded.amount;
  end if;
  if plan_kind='family' then
    insert into public.family_audit(family_id,actor_id,actor_name,actor_kind,action,object_type,object_id,before_data,after_data)
      values(p_plan,auth.uid(),coalesce(nullif(actor.nickname,''),actor.email),'user',
        case when before_amount is null then 'INSERT' when p_amount is null then 'DELETE' else 'UPDATE' end,
        'family_fact_override',coalesce(nullif(item,''),p_category),
        case when before_amount is not null then jsonb_build_object('month',p_month,'title',coalesce(item_title,title),'amount',before_amount) end,
        case when p_amount is not null then jsonb_build_object('month',p_month,'title',coalesce(item_title,title),'amount',p_amount) end);
  end if;
  update expense_tracking.plans p set revision=p.revision+1 where p.id=p_plan;
  return public.expense_tracking_get(p_plan);
end $$;

create or replace function public.expense_tracking_set_category_fact(
  p_plan uuid,p_month text,p_category text,p_amount numeric,p_previous numeric
) returns jsonb language sql set search_path='' as $$
  select public.expense_tracking_set_category_fact(p_plan,p_month,p_category,p_amount,p_previous,'');
$$;

revoke execute on function public.expense_tracking_set_category_fact(uuid,text,text,numeric,numeric,text) from public, anon;
grant execute on function public.expense_tracking_set_category_fact(uuid,text,text,numeric,numeric,text) to authenticated;
notify pgrst, 'reload schema';
