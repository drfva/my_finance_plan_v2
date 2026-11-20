-- A purchase can explain an existing manual total or increase it. Keep this
-- choice separately from included_in_fact, which belongs to the legacy facts.
alter table expense_tracking.purchases add column if not exists manual_fact_included boolean;
-- Signed adjustments let edits/deletes reverse only what this purchase added,
-- without undoing the user's later manual total.
create table if not exists expense_tracking.purchase_fact_effects (
  plan_id uuid not null,
  purchase_id uuid not null,
  month text not null,
  category_id text not null,
  item_id text not null,
  extra numeric not null,
  primary key(plan_id,purchase_id,month,category_id,item_id),
  foreign key(plan_id,purchase_id) references expense_tracking.purchases(plan_id,id) on delete cascade,
  foreign key(plan_id,month,category_id,item_id) references expense_tracking.fact_overrides(plan_id,month,category_id,item_id) on delete cascade
);
alter table expense_tracking.purchase_fact_effects enable row level security;
revoke all on expense_tracking.purchase_fact_effects from public,anon,authenticated;

do $$ begin
  if to_regprocedure('expense_tracking.command_before_purchase_facts(uuid,text,jsonb,bigint)') is null then
    alter function public.expense_tracking_command(uuid,text,jsonb,bigint) rename to command_before_purchase_facts;
    alter function public.command_before_purchase_facts(uuid,text,jsonb,bigint) set schema expense_tracking;
    revoke all on function expense_tracking.command_before_purchase_facts(uuid,text,jsonb,bigint) from public,anon,authenticated;
  end if;
  if to_regprocedure('expense_tracking.set_fact_before_purchases(uuid,text,text,numeric,numeric,text)') is null then
    alter function public.expense_tracking_set_category_fact(uuid,text,text,numeric,numeric,text) rename to set_fact_before_purchases;
    alter function public.set_fact_before_purchases(uuid,text,text,numeric,numeric,text) set schema expense_tracking;
    revoke all on function expense_tracking.set_fact_before_purchases(uuid,text,text,numeric,numeric,text) from public,anon,authenticated;
  end if;
end $$;

create or replace function public.expense_tracking_set_category_fact(
  p_plan uuid,p_month text,p_category text,p_amount numeric,p_previous numeric,p_item text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare before_amount numeric;
begin
  if auth.uid() is null or not public.is_account_member(p_plan) then raise sqlstate 'PT403' using message='Нет доступа к плану'; end if;
  perform 1 from public.accounts a where a.id=p_plan for update;
  select o.amount into before_amount from expense_tracking.fact_overrides o
    where o.plan_id=p_plan and o.month=p_month and o.category_id=p_category and o.item_id=coalesce(p_item,'');
  perform expense_tracking.set_fact_before_purchases(p_plan,p_month,p_category,p_amount,p_previous,p_item);
  if p_amount is distinct from before_amount then
    -- Replacing the total establishes a new baseline containing existing buys.
    delete from expense_tracking.purchase_fact_effects e
      where e.plan_id=p_plan and e.month=p_month and e.category_id=p_category and e.item_id=coalesce(p_item,'');
  end if;
  return public.expense_tracking_get(p_plan);
end $$;

create or replace function public.expense_tracking_command(p_plan uuid,p_action text,p_payload jsonb,p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  old_purchase expense_tracking.purchases;
  target uuid;
  settings expense_tracking.plans;
  is_family boolean;
  effects jsonb;
  f record;
  month_key text;
  category text;
  item text;
  entry_amount numeric;
  baseline numeric;
  addition numeric;
  other_purchases numeric;
  covered boolean;
  has_override boolean;
begin
  if p_action not in ('purchase_save','purchase_delete') then
    return expense_tracking.command_before_purchase_facts(p_plan,p_action,p_payload,p_revision);
  end if;
  if auth.uid() is null or not public.is_account_member(p_plan) then raise sqlstate '42501' using message='Нет доступа к плану'; end if;
  select a.plan_kind='family' into is_family from public.accounts a where a.id=p_plan for update;
  if is_family then perform family_api.require_member(p_plan,true);
  elsif not public.can_edit_account(p_plan) then raise sqlstate '42501' using message='Нет доступа к редактированию плана'; end if;
  select * into settings from expense_tracking.plans t where t.id=p_plan for update;
  if settings.id is null or settings.revision is distinct from p_revision then
    raise sqlstate 'PT409' using message='Учет изменился в другой вкладке. Обновите данные.';
  end if;
  target := coalesce((p_payload->>'id')::uuid,gen_random_uuid());
  p_payload := p_payload || jsonb_build_object('id',target);
  select * into old_purchase from expense_tracking.purchases p where p.plan_id=p_plan and p.id=target;
  select coalesce(jsonb_agg(to_jsonb(e)),'[]') into effects from expense_tracking.purchase_fact_effects e
    where e.plan_id=p_plan and e.purchase_id=target;
  -- Undo the old contribution first; any validation failure rolls back all of it.
  for f in select * from jsonb_to_recordset(effects) x(month text,category_id text,item_id text,extra numeric) loop
    update expense_tracking.fact_overrides o set amount=o.amount-f.extra
      where o.plan_id=p_plan and o.month=f.month and o.category_id=f.category_id and o.item_id=f.item_id;
  end loop;
  delete from expense_tracking.purchase_fact_effects e where e.plan_id=p_plan and e.purchase_id=target;
  if p_action='purchase_delete' then
    perform expense_tracking.command_before_purchase_facts(p_plan,p_action,p_payload,p_revision);
    return public.expense_tracking_get(p_plan);
  end if;
  month_key := to_char((p_payload->>'date')::date,'YYYY-MM');
  category := p_payload->>'category_id'; item := coalesce(p_payload->>'item_id','');
  entry_amount := (p_payload->>'amount')::numeric;
  covered := coalesce((p_payload->>'included_in_fact')::boolean,false);
  select exists(select 1 from expense_tracking.fact_overrides o where o.plan_id=p_plan
    and o.month=month_key and o.category_id=category and (o.item_id='' or o.item_id=item)) into has_override;
  for f in select * from expense_tracking.fact_overrides o where o.plan_id=p_plan and o.month=month_key
    and o.category_id=category and (o.item_id='' or o.item_id=item) loop
    if covered then
      select coalesce(sum(p.total),0) into other_purchases from expense_tracking.purchases p where p.plan_id=p_plan
        and p.id<>target and p.category_id=category and (f.item_id='' or p.item_id=item)
        and to_char(p.occurred_on,'YYYY-MM')=month_key;
      if f.amount-other_purchases<entry_amount then
        raise exception 'Сумма покупки больше неразобранного ручного факта за этот месяц';
      end if;
    end if;
  end loop;
  perform expense_tracking.command_before_purchase_facts(p_plan,p_action,
    -- Modern manual totals are checked above; do not validate legacy facts too.
    case when has_override then p_payload || jsonb_build_object('included_in_fact',false) else p_payload end,p_revision);
  update expense_tracking.purchases p set manual_fact_included=case when has_override then covered else null end
    where p.plan_id=p_plan and p.id=target;
  for f in select * from expense_tracking.fact_overrides o where o.plan_id=p_plan and o.month=month_key
    and o.category_id=category and (o.item_id='' or o.item_id=item) loop
    baseline := 0;
    if covered then baseline := entry_amount;
    elsif old_purchase.id is not null and to_char(old_purchase.occurred_on,'YYYY-MM')=month_key
      and old_purchase.category_id=category and (f.item_id='' or old_purchase.item_id=item) then
      select old_purchase.total-coalesce((select x.extra from jsonb_to_recordset(effects)
        x(month text,category_id text,item_id text,extra numeric)
        where x.month=f.month and x.category_id=f.category_id and x.item_id=f.item_id),0) into baseline;
    end if;
    addition := entry_amount-baseline;
    update expense_tracking.fact_overrides o set amount=o.amount+addition
      where o.plan_id=p_plan and o.month=f.month and o.category_id=f.category_id and o.item_id=f.item_id;
    insert into expense_tracking.purchase_fact_effects values(p_plan,target,f.month,f.category_id,f.item_id,addition);
  end loop;
  return public.expense_tracking_get(p_plan);
end $$;

revoke execute on function public.expense_tracking_command(uuid,text,jsonb,bigint),
  public.expense_tracking_set_category_fact(uuid,text,text,numeric,numeric,text) from public,anon;
grant execute on function public.expense_tracking_command(uuid,text,jsonb,bigint),
  public.expense_tracking_set_category_fact(uuid,text,text,numeric,numeric,text) to authenticated;
notify pgrst,'reload schema';
