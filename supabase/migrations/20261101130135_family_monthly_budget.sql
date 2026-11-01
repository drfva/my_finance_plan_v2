begin;

alter table public.families add column if not exists plan_years integer[] not null
  default array[extract(year from now() at time zone 'Europe/Moscow')::integer];

alter table public.family_categories
  add column if not exists mode text not null default 'fixed_month' check (mode in ('fixed_month','percent_month')),
  add column if not exists monthly_amount numeric not null default 0 check (monthly_amount >= 0 and monthly_amount < 'Infinity'::numeric),
  add column if not exists percent_value numeric not null default 0 check (percent_value between 0 and 100),
  add column if not exists season_from text,
  add column if not exists season_to text,
  add column if not exists amount_seasons jsonb not null default '[]' check (api_private.valid_amount_seasons(amount_seasons)),
  add column if not exists starts_on date not null default date_trunc('month',now() at time zone 'Europe/Moscow')::date,
  add column if not exists archived boolean not null default false;

-- Старые месячные суммы остаются отдельными исключениями. Последняя — шаблон
-- следующих месяцев; поздняя правка шаблона не должна менять закрытые месяцы.
update public.family_categories c set monthly_amount=e.amount,
  starts_on=least(c.starts_on,(select min(x.month||'-01')::date from public.family_monthly_expenses x where x.family_id=c.family_id and x.category_id=c.id))
from (select distinct on (family_id,category_id) family_id,category_id,amount from public.family_monthly_expenses order by family_id,category_id,month desc) e
where c.family_id=e.family_id and c.id=e.category_id and not exists(
  select 1 from pg_description d where d.objoid='public.family_categories'::regclass and d.objsubid=(select attnum from pg_attribute where attrelid=d.objoid and attname='starts_on') and d.description='family-monthly-budget-v2');
-- У старого родителя могло не быть собственной суммы: расходы вводились
-- только в подкатегории. Их история определяет начало действия родителя.
update public.family_categories c set starts_on=least(c.starts_on,e.first_month)
from (select child.family_id,child.parent_id,min(x.month||'-01')::date first_month
  from public.family_categories child join public.family_monthly_expenses x on x.family_id=child.family_id and x.category_id=child.id
  where child.parent_id is not null group by child.family_id,child.parent_id) e
where c.family_id=e.family_id and c.id=e.parent_id
  and col_description('public.family_categories'::regclass,(select attnum from pg_attribute where attrelid='public.family_categories'::regclass and attname='starts_on')) is distinct from 'family-monthly-budget-v2';
comment on column public.family_categories.starts_on is 'family-monthly-budget-v2';

alter table public.family_contributions add column if not exists allocation_snapshot jsonb
  check (allocation_snapshot is null or jsonb_typeof(allocation_snapshot)='array');

create table if not exists public.family_allocation_overrides (
  family_id uuid not null references public.families(id),
  member_id uuid not null references public.family_members(id),
  period_id text not null,
  category_id text not null,
  amount numeric not null check (amount >= 0 and amount < 'Infinity'::numeric),
  primary key (family_id,member_id,period_id,category_id),
  foreign key(family_id,category_id) references public.family_categories(family_id,id)
);
create table if not exists public.family_budget_months (
  family_id uuid not null references public.families(id),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  targets jsonb not null check (jsonb_typeof(targets)='array'),
  primary key(family_id,month)
);
alter table public.family_allocation_overrides enable row level security;
alter table public.family_budget_months enable row level security;
revoke all on public.family_allocation_overrides,public.family_budget_months from public,anon,authenticated;

create or replace function family_api.budget_active(r jsonb,d date)
returns boolean language sql immutable security invoker set search_path='' as $$
  select not coalesce((r->>'archived')::boolean,false) and (r->>'starts_on' is null or d >= (r->>'starts_on')::date)
    and (nullif(r->>'season_from','') is null or nullif(r->>'season_to','') is null or
      case when r->>'season_from'<=r->>'season_to' then to_char(d,'MM-DD') between r->>'season_from' and r->>'season_to'
      else to_char(d,'MM-DD')>=r->>'season_from' or to_char(d,'MM-DD')<=r->>'season_to' end);
$$;
create or replace function family_api.budget_value(r jsonb,d date,p_percent boolean)
returns numeric language sql immutable security invoker set search_path='' as $$
  select case when not family_api.budget_active(r,d) then 0
    when p_percent then coalesce((r->>'percent_value')::numeric,0)
    else coalesce((select (s->>'amount')::numeric from jsonb_array_elements(coalesce(r->'amount_seasons','[]')) s
      where case when s->>'from'<=s->>'to' then to_char(d,'MM-DD') between s->>'from' and s->>'to'
        else to_char(d,'MM-DD')>=s->>'from' or to_char(d,'MM-DD')<=s->>'to' end limit 1),(r->>'monthly_amount')::numeric,0) end;
$$;

-- Единственный расчёт семейного бюджета: браузер получает готовый результат
-- из этого же SQL, которым сервер закрепляет распределение взносов.
create or replace function family_api.budget_plan(p_family uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
with
  cfg as (select greatest(.01,coalesce((select (value#>>'{}')::numeric from public.account_settings where account_id=p_family and key='rounding'),1)) step),
  payments as (select c.*,to_char(c.pay_date,'YYYY-MM') as month from public.family_contributions c where c.family_id=p_family),
  dates as (select pay_date d from payments where amount>0 union select (month||'-01')::date from public.family_monthly_expenses where family_id=p_family
    union select (month||'-01')::date from public.family_expense_facts where family_id=p_family
    union select make_date(y,1,1) from public.families f cross join lateral unnest(f.plan_years) y where f.id=p_family
    union select (now() at time zone 'Europe/Moscow')::date),
  months as (select to_char(d,'YYYY-MM') as month,d::date as day from generate_series(
    (select date_trunc('year',min(d)) from dates),(select date_trunc('year',max(d))+interval '11 months' from dates),interval '1 month') d),
  income as (select m.month,coalesce(sum(p.amount),0) expected,
    coalesce(sum(p.amount) filter(where p.status='posted'),0) received,
    coalesce(sum(p.amount) filter(where p.status='forecast'),0) future
    from months m left join payments p using(month) group by m.month),
  leaves as (select c.*,to_jsonb(c) leaf,to_jsonb(r) root,r.mode root_mode,
      r.title root_title,exists(select 1 from public.family_categories x where x.family_id=c.family_id and x.parent_id=c.id and not x.archived) has_children
    from public.family_categories c join public.family_categories r on r.family_id=c.family_id and r.id=coalesce(c.parent_id,c.id)
    where c.family_id=p_family and not c.archived and not r.archived),
  current_targets as (select m.month,l.id category_id,l.parent_id,l.title,l.root_title,l.root_mode mode,
    round(coalesce(e.amount,case when i.expected>0 then
      (select sum(p.amount * case when family_api.budget_active(l.root,p.pay_date)
        then family_api.budget_value(l.leaf,p.pay_date,l.root_mode='percent_month') else 0 end) from payments p where p.month=m.month)
        / case when l.root_mode='percent_month' then 100 else i.expected end
      else case when l.root_mode='percent_month' then 0
        when family_api.budget_active(l.root,m.day+14) then family_api.budget_value(l.leaf,m.day+14,false) else 0 end end)/(select step from cfg))*(select step from cfg) target
    from months m cross join leaves l join income i on i.month=m.month
    left join public.family_monthly_expenses e on e.family_id=p_family and e.category_id=l.id and e.month=m.month
    where not exists(select 1 from public.family_budget_months h where h.family_id=p_family and h.month=m.month)
      and (not l.has_children or e.category_id is not null)),
  raw_targets as (select * from current_targets union all
    select h.month,t->>'category_id',nullif(t->>'parent_id',''),t->>'title',t->>'root_title',t->>'mode',(t->>'target')::numeric
    from public.family_budget_months h cross join lateral jsonb_array_elements(h.targets) t where h.family_id=p_family),
  frozen as (select p.id,p.month,e->>'category_id' category_id,(e->>'amount')::numeric amount,e entry
    from payments p cross join lateral jsonb_array_elements(p.allocation_snapshot) e where p.status='posted' and p.allocation_snapshot is not null),
  frozen_totals as (select month,category_id,sum(amount) amount from frozen group by month,category_id),
  basis as (select t.*,coalesce(f.amount,0) given,greatest(0,t.target-coalesce(f.amount,0)) need
    from raw_targets t left join frozen_totals f using(month,category_id)),
  target_weights as (select b.*,sum(need) over(partition by month,coalesce(parent_id,category_id)) total_need,
    sum(need) over(partition by month,coalesce(parent_id,category_id) order by category_id rows between unbounded preceding and current row) cumulative_need,
    coalesce((select sum(f.amount) from frozen f where f.month=b.month and coalesce(f.entry->>'parent_id',f.category_id)=coalesce(b.parent_id,b.category_id)
      and not exists(select 1 from raw_targets r where r.month=f.month and r.category_id=f.category_id)),0)
      +sum(greatest(0,given-target)) over(partition by month,coalesce(parent_id,category_id)) credit
    from basis b),
  targets as (select month,category_id,parent_id,title,root_title,mode,greatest(target,given) - case when total_need>0
    then round(least(credit,total_need)*cumulative_need/total_need/(select step from cfg))*(select step from cfg)
      -round(least(credit,total_need)*(cumulative_need-need)/total_need/(select step from cfg))*(select step from cfg) else 0 end target from target_weights),
  fixed as (select month,category_id,sum(amount) amount from (
    select month,category_id,amount from frozen union all
    select p.month,o.category_id,o.amount from payments p join public.family_allocation_overrides o
      on o.family_id=p.family_id and o.member_id=p.member_id and o.period_id=p.period_id
      where p.allocation_snapshot is null) x group by month,category_id),
  live as (select p.id,p.member_id,p.period_id,p.pay_date,p.month,t.category_id,t.parent_id,t.title,t.root_title,t.mode,t.target,o.amount manual_amount,
    case when family_api.budget_active(l.root,p.pay_date) and family_api.budget_active(l.leaf,p.pay_date)
      then p.amount*coalesce(e.amount,family_api.budget_value(l.leaf,p.pay_date,t.mode='percent_month')) else 0 end weight,
    greatest(0,t.target-coalesce(f.amount,0)) remaining
    from payments p join targets t on t.month=p.month
    join leaves l on l.id=t.category_id
    left join public.family_monthly_expenses e on e.family_id=p_family and e.category_id=t.category_id and e.month=t.month
    left join fixed f on f.month=t.month and f.category_id=t.category_id
    left join public.family_allocation_overrides o on o.family_id=p.family_id and o.member_id=p.member_id and o.period_id=p.period_id and o.category_id=t.category_id
    where p.allocation_snapshot is null),
  weighted as (select *,coalesce(sum(weight) filter(where manual_amount is null) over(partition by month,category_id),0) total_weight,
    coalesce(sum(weight) filter(where manual_amount is null) over(partition by month,category_id order by pay_date,member_id,period_id rows between unbounded preceding and current row),0) cumulative
    from live),
  parts as (select id,month,category_id,jsonb_build_object('category_id',category_id,'parent_id',parent_id,'title',title,'parent_title',root_title,
    'mode',mode,'manual',manual_amount is not null,'amount',coalesce(manual_amount,case when total_weight>0
      then (round(remaining*cumulative/total_weight/(select step from cfg))-round(remaining*(cumulative-weight)/total_weight/(select step from cfg)))*(select step from cfg) else 0 end)) entry
    from weighted),
  all_parts as (select id,month,category_id,entry from frozen union all select * from parts),
  allocated as (select month,category_id,sum((entry->>'amount')::numeric) amount from all_parts group by month,category_id),
  plans as (select coalesce(t.month,a.month) as month,coalesce(t.category_id,a.category_id) category_id,
    greatest(coalesce(t.target,0),coalesce(a.amount,0)) planned,coalesce(a.amount,0) allocated
    from targets t full join allocated a on a.month=t.month and a.category_id=t.category_id),
  month_plans as (select month,sum(planned) planned,sum(allocated) allocated from plans group by month),
  fact as (select month,sum(amount) actual from public.family_expense_facts where family_id=p_family group by month)
select jsonb_build_object(
  'rows',coalesce((select jsonb_agg(jsonb_build_object('contribution_id',p.id,'member_id',p.member_id,'period_id',p.period_id,
    'pay_date',p.pay_date,'income',p.amount,'locked',p.allocation_snapshot is not null,
    'allocations',coalesce((select jsonb_agg(a.entry order by a.entry->>'parent_id',a.category_id) from all_parts a where a.id=p.id),'[]'),
    'expenses',coalesce((select sum((a.entry->>'amount')::numeric) from all_parts a where a.id=p.id),0)) order by p.pay_date,p.member_id,p.period_id) from payments p),'[]'),
  'months',coalesce((select jsonb_agg(jsonb_build_object('month',i.month,'received',i.received,'future',i.future,'expected',i.expected,
    'planned',coalesce(mp.planned,0),'allocated',coalesce(mp.allocated,0),'actual',coalesce(f.actual,0),
    'unassigned',greatest(0,coalesce(mp.planned,0)-coalesce(mp.allocated,0)),
    'targets',coalesce((select jsonb_agg(to_jsonb(t)-'month' order by t.category_id) from targets t where t.month=i.month),'[]'),
    'freeze_targets',coalesce((select jsonb_agg(to_jsonb(t)-'month' order by t.category_id) from raw_targets t where t.month=i.month),'[]')) order by i.month)
    from income i left join month_plans mp using(month) left join fact f using(month)),'[]'));
$$;

create or replace function family_api.freeze_budget(p_family uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare plan jsonb; r jsonb; begin
  perform 1 from public.families where id=p_family for update;
  update public.families f set plan_years=(select array_agg(y order by y) from (
    select unnest(f.plan_years) y
    union select extract(year from pay_date)::integer from public.family_contributions where family_id=p_family
    union select left(month,4)::integer from public.family_monthly_expenses where family_id=p_family
    union select left(month,4)::integer from public.family_expense_facts where family_id=p_family
    union select extract(year from now() at time zone 'Europe/Moscow')::integer
  ) years) where f.id=p_family;
  plan:=family_api.budget_plan(p_family);
  for r in select value from jsonb_array_elements(plan->'months') loop
    if r->>'month'<to_char(now() at time zone 'Europe/Moscow','YYYY-MM') then
      insert into public.family_budget_months(family_id,month,targets) values(p_family,r->>'month',r->'freeze_targets') on conflict do nothing;
    end if;
  end loop;
  for r in select value from jsonb_array_elements(plan->'rows') loop
    update public.family_contributions set allocation_snapshot=r->'allocations'
      where family_id=p_family and id=(r->>'contribution_id')::uuid and status='posted' and allocation_snapshot is null;
  end loop;
end $$;

-- Расширяем существующие операции, сохраняя их проверку участия, версий,
-- идемпотентности и личную приватность. Исходные RPC и сигнатуры не меняются.
do $migration$
declare definition text; begin
  definition:=pg_get_functiondef('family_api.command(text,uuid,jsonb,bigint,uuid)'::regprocedure);
  if position('family-monthly-budget-v2' in definition)=0 then
    definition:=replace(definition,'    if p_action = ''category'' then', $code$
    -- family-monthly-budget-v2
    if p_action in ('category','delete_category','expense','allocation','reset_allocations') then
      perform family_api.freeze_budget(p_family);
    end if;
    if p_action in ('allocation','reset_allocations') then
      declare contribution public.family_contributions; selected_category public.family_categories; n numeric; begin
        select * into contribution from public.family_contributions c where c.family_id=p_family
          and c.member_id=(p_payload->>'member_id')::uuid and c.period_id=p_payload->>'period_id';
        if contribution.id is null then raise sqlstate 'PT404' using message='Взнос не найден. Обновите семейный план'; end if;
        if contribution.status='posted' or contribution.pay_date<=(now() at time zone 'Europe/Moscow')::date then
          raise sqlstate 'PT409' using message='Распределение прошедшего взноса зафиксировано';
        end if;
        if p_action='reset_allocations' then
          delete from public.family_allocation_overrides o where o.family_id=p_family and o.member_id=contribution.member_id and o.period_id=contribution.period_id;
        else
          select * into selected_category from public.family_categories c where c.family_id=p_family and c.id=p_payload->>'category_id' and not c.archived;
          if selected_category.id is null or exists(select 1 from public.family_categories c where c.family_id=p_family and c.parent_id=selected_category.id and not c.archived) then
            raise sqlstate 'PT400' using message='Выберите категорию без подкатегорий или отдельную подкатегорию';
          end if;
          if p_payload->>'amount' is null then
            delete from public.family_allocation_overrides o where o.family_id=p_family and o.member_id=contribution.member_id and o.period_id=contribution.period_id and o.category_id=selected_category.id;
          else
            n:=(p_payload->>'amount')::numeric;
            insert into public.family_allocation_overrides(family_id,member_id,period_id,category_id,amount)
              values(p_family,contribution.member_id,contribution.period_id,selected_category.id,n)
              on conflict(family_id,member_id,period_id,category_id) do update set amount=excluded.amount;
          end if;
        end if;
      end;
    elsif p_action = 'category' then$code$);
    definition:=replace(definition,$old$
      insert into public.family_categories(family_id,id,title,parent_id,sort_order)
        values(p_family,p_payload->>'id',btrim(p_payload->>'title'),parent,coalesce((p_payload->>'sort_order')::integer,0))
        on conflict(family_id,id) do update set title=excluded.title;$old$,$new$
      if parent is not null and not exists(select 1 from public.family_categories c where c.family_id=p_family and c.id=p_payload->>'id') then
        delete from public.family_monthly_expenses e where e.family_id=p_family and e.month>=to_char(now() at time zone 'Europe/Moscow','YYYY-MM')
          and (e.category_id=parent or e.category_id in(select c.id from public.family_categories c where c.family_id=p_family and c.parent_id=parent));
      end if;
      if nullif(p_payload->>'season_from','') is not null and not api_private.valid_amount_seasons(jsonb_build_array(jsonb_build_object('from',p_payload->>'season_from','to',p_payload->>'season_from','amount',0)))
        or nullif(p_payload->>'season_to','') is not null and not api_private.valid_amount_seasons(jsonb_build_array(jsonb_build_object('from',p_payload->>'season_to','to',p_payload->>'season_to','amount',0))) then
        raise sqlstate 'PT400' using message='Укажите существующую дату периода в формате ММ-ДД';
      end if;
      insert into public.family_categories(family_id,id,title,parent_id,sort_order,mode,monthly_amount,percent_value,season_from,season_to,amount_seasons)
        values(p_family,p_payload->>'id',btrim(coalesce(p_payload->>'title',(select c.title from public.family_categories c where c.family_id=p_family and c.id=p_payload->>'id'))),parent,coalesce((p_payload->>'sort_order')::integer,0),
          coalesce(p_payload->>'mode','fixed_month'),coalesce((p_payload->>'monthly_amount')::numeric,0),coalesce((p_payload->>'percent_value')::numeric,0),
          nullif(p_payload->>'season_from',''),nullif(p_payload->>'season_to',''),coalesce(p_payload->'amount_seasons','[]'))
        on conflict(family_id,id) do update set title=excluded.title,
          mode=case when p_payload?'mode' then excluded.mode else family_categories.mode end,
          monthly_amount=case when p_payload?'monthly_amount' then excluded.monthly_amount else family_categories.monthly_amount end,
          percent_value=case when p_payload?'percent_value' then excluded.percent_value else family_categories.percent_value end,
          season_from=case when p_payload?'season_from' then excluded.season_from else family_categories.season_from end,
          season_to=case when p_payload?'season_to' then excluded.season_to else family_categories.season_to end,
          amount_seasons=case when p_payload?'amount_seasons' then excluded.amount_seasons else family_categories.amount_seasons end;
      if p_payload ?| array['mode','monthly_amount','percent_value','season_from','season_to','amount_seasons'] then
        delete from public.family_monthly_expenses where family_id=p_family and month>=to_char(now() at time zone 'Europe/Moscow','YYYY-MM')
          and (category_id=p_payload->>'id' or category_id in(select c.id from public.family_categories c where c.family_id=p_family and c.parent_id=p_payload->>'id'));
      end if;$new$);
    definition:=replace(definition,'delete from public.family_categories where family_id = p_family and id = p_payload->>''id'';', $code$
      select coalesce(c.parent_id,c.id) into parent from public.family_categories c where c.family_id=p_family and c.id=p_payload->>'id';
      update public.family_categories set archived=true where family_id=p_family and (id=p_payload->>'id' or parent_id=p_payload->>'id');
      delete from public.family_monthly_expenses e where e.family_id=p_family and e.month>=to_char(now() at time zone 'Europe/Moscow','YYYY-MM')
        and (e.category_id=parent or e.category_id in(select c.id from public.family_categories c where c.family_id=p_family and c.parent_id=parent));$code$);
    if position('on conflict(family_id,id) do update set title=excluded.title;' in definition)>0 then raise exception 'Не удалось расширить семейные категории'; end if;
    execute definition;
  end if;
  definition:=pg_get_functiondef('family_api.read(uuid)'::regprocedure);
  if position('family-monthly-budget-v2' in definition)=0 then
    definition:=replace(definition,'result jsonb; begin','result jsonb; budget jsonb; begin');
    definition:=replace(definition,'  return result;', $code$
  -- family-monthly-budget-v2: раскрываем только уже разрешённые взносы.
  budget:=family_api.budget_plan(p_family);
  return result || jsonb_build_object('budget',jsonb_set(budget,'{rows}',coalesce(
    (select jsonb_agg(r) from jsonb_array_elements(budget->'rows') r
      where exists(select 1 from jsonb_array_elements(result->'contributions') c where c->>'id'=r->>'contribution_id')),'[]')));$code$);
    execute definition;
  end if;
  definition:=pg_get_functiondef('family_api.worker_commit(uuid,bigint,jsonb,jsonb,jsonb,boolean)'::regprocedure);
  if position('family_api.freeze_budget(f)' in definition)=0 then
    definition:=replace(definition,'  update public.families set version=version+1 where id=f;',
      '  perform family_api.freeze_budget(f); update public.families set version=version+1 where id=f;');
    execute definition;
  end if;
end $migration$;

create or replace function family_api.protect_budget_snapshot()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.allocation_snapshot is not null and (new.allocation_snapshot is distinct from old.allocation_snapshot
    or new.status is distinct from old.status or new.amount is distinct from old.amount or new.pay_date is distinct from old.pay_date
    or new.member_id is distinct from old.member_id or new.period_id is distinct from old.period_id or new.family_id is distinct from old.family_id
    -- Удаление аккаунта отвязывает личный источник, сохраняя семейные суммы.
    or new.source_account_id is distinct from old.source_account_id and new.source_account_id is not null) then
    raise sqlstate 'PT409' using message='Проведённый взнос и его распределение зафиксированы';
  end if;
  return new;
end $$;
drop trigger if exists protect_family_budget_snapshot on public.family_contributions;
create trigger protect_family_budget_snapshot before update on public.family_contributions for each row execute function family_api.protect_budget_snapshot();

drop trigger if exists family_audit_trigger on public.family_allocation_overrides;
create trigger family_audit_trigger after insert or update or delete on public.family_allocation_overrides for each row execute function family_api.audit_change();
revoke execute on function family_api.budget_active(jsonb,date),family_api.budget_value(jsonb,date,boolean),family_api.budget_plan(uuid),
  family_api.freeze_budget(uuid),family_api.protect_budget_snapshot() from public,anon,authenticated,service_role;

do $$ declare f uuid; begin
  for f in select id from public.families where deleted_at is null loop perform family_api.freeze_budget(f); end loop;
end $$;
notify pgrst, 'reload schema';
commit;
