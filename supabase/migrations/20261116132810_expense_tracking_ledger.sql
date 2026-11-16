-- Journal data has a single write path. Account membership is checked on every RPC.
create schema if not exists expense_tracking;
revoke all on schema expense_tracking from public, anon, authenticated;

create table if not exists expense_tracking.plans (
  id uuid primary key references public.accounts(id) on delete cascade,
  started_on date not null,
  fact_mode text not null check (fact_mode in ('reset', 'add')),
  deposit_account uuid not null,
  debit_account uuid not null,
  revision bigint not null default 0
);

create table if not exists expense_tracking.accounts (
  plan_id uuid not null references expense_tracking.plans(id) on delete cascade,
  id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 160),
  opening_amount numeric(16,2) not null check (opening_amount <> 'NaN'::numeric),
  opening_date date not null check (isfinite(opening_date)),
  primary key (plan_id, id)
);

create table if not exists expense_tracking.purchases (
  plan_id uuid not null references expense_tracking.plans(id) on delete cascade,
  id uuid not null,
  occurred_on date not null,
  category_id text not null,
  category_title text not null,
  item_id text not null default '',
  item_title text not null default '',
  total numeric(16,2) not null check (total > 0),
  included_in_fact boolean not null default false,
  tags text[] not null default '{}',
  note text not null default '' check (length(note) <= 2000),
  primary key (plan_id, id)
);
create index if not exists expense_tracking_purchases_date_idx
  on expense_tracking.purchases(plan_id, occurred_on desc, id);

create table if not exists expense_tracking.parts (
  plan_id uuid not null,
  purchase_id uuid not null,
  account_id uuid not null,
  amount numeric(16,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  primary key (plan_id, purchase_id, account_id),
  foreign key (plan_id, purchase_id) references expense_tracking.purchases(plan_id, id) on delete cascade,
  foreign key (plan_id, account_id) references expense_tracking.accounts(plan_id, id) on delete cascade
);
create index if not exists expense_tracking_parts_account_idx
  on expense_tracking.parts(plan_id, account_id);

create table if not exists expense_tracking.movements (
  plan_id uuid not null references expense_tracking.plans(id) on delete cascade,
  id uuid not null,
  occurred_on date not null check (isfinite(occurred_on)),
  from_account uuid,
  to_account uuid not null,
  amount numeric(16,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  note text not null default '' check (length(note) <= 2000),
  primary key (plan_id, id),
  foreign key (plan_id, from_account) references expense_tracking.accounts(plan_id, id) on delete cascade,
  foreign key (plan_id, to_account) references expense_tracking.accounts(plan_id, id) on delete cascade,
  check (from_account is distinct from to_account)
);
create index if not exists expense_tracking_movements_from_idx on expense_tracking.movements(plan_id, from_account);
create index if not exists expense_tracking_movements_to_idx on expense_tracking.movements(plan_id, to_account);

alter table expense_tracking.plans enable row level security;
alter table expense_tracking.accounts enable row level security;
alter table expense_tracking.purchases enable row level security;
alter table expense_tracking.parts enable row level security;
alter table expense_tracking.movements enable row level security;
revoke all on all tables in schema expense_tracking from public, anon, authenticated;

create or replace function public.expense_tracking_get(p_plan uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  settings expense_tracking.plans;
  today date := (now() at time zone 'Europe/Moscow')::date;
begin
  if auth.uid() is null or not public.is_account_member(p_plan) then
    raise exception using errcode = '42501', message = 'Нет доступа к плану';
  end if;
  if exists(select 1 from public.accounts where id=p_plan and plan_kind='family') then
    perform family_api.require_member(p_plan);
  end if;
  select * into settings from expense_tracking.plans where id = p_plan;
  if not found then return jsonb_build_object('enabled', false); end if;

  return jsonb_build_object('enabled', true, 'settings', to_jsonb(settings) - 'id',
    'accounts', coalesce((
      select jsonb_agg(to_jsonb(a) - 'plan_id' || jsonb_build_object('balance',
        case when a.opening_date <= today then a.opening_amount else null end
          + coalesce((select sum(case when m.to_account=a.id then m.amount else -m.amount end)
            from expense_tracking.movements m where m.plan_id=p_plan
            and (m.to_account=a.id or m.from_account=a.id) and m.occurred_on between a.opening_date and today), 0)
          - coalesce((select sum(s.amount) from expense_tracking.parts s
            join expense_tracking.purchases p on (p.plan_id,p.id)=(s.plan_id,s.purchase_id)
            where s.plan_id=p_plan and s.account_id=a.id and p.occurred_on between a.opening_date and today), 0)
      ) order by a.title, a.id) from expense_tracking.accounts a where a.plan_id=p_plan
    ), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(to_jsonb(p) - 'plan_id' || jsonb_build_object('parts',
        (select jsonb_agg(jsonb_build_object('account_id',s.account_id,'amount',s.amount) order by s.account_id)
         from expense_tracking.parts s where s.plan_id=p_plan and s.purchase_id=p.id)
      ) order by p.occurred_on desc,p.id) from expense_tracking.purchases p where p.plan_id=p_plan
    ), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(to_jsonb(m) - 'plan_id' order by m.occurred_on desc,m.id)
      from expense_tracking.movements m where m.plan_id=p_plan
    ), '[]'::jsonb));
end;
$$;

create or replace function public.expense_tracking_command(
  p_plan uuid, p_action text, p_payload jsonb, p_revision bigint default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  settings expense_tracking.plans;
  new_id uuid := (p_payload->>'id')::uuid;
  entry_date date := (p_payload->>'date')::date;
  today date := (now() at time zone 'Europe/Moscow')::date;
  is_family boolean;
  account_from uuid;
  account_to uuid;
  category text := p_payload->>'category_id';
  item text := coalesce(p_payload->>'item_id', '');
  category_name text;
  item_name text := '';
  entry_amount numeric;
  base_fact numeric;
  already_covered numeric;
  existing_count int;
  distinct_count int;
  parts_total numeric;
  covered boolean := coalesce((p_payload->>'included_in_fact')::boolean,false);
  entry_note text := coalesce(p_payload->>'note','');
  entry_tags text[];
  family_actor public.family_members;
  purchase_before jsonb;
  purchase_after jsonb;
begin
  if auth.uid() is null or not public.is_account_member(p_plan) then
    raise exception using errcode = '42501', message = 'Нет доступа к редактированию плана';
  end if;
  -- Also serializes activation before its settings row exists.
  select plan_kind='family' into is_family from public.accounts where id=p_plan for update;
  if is_family then
    family_actor := family_api.require_member(p_plan,true);
  elsif not public.can_edit_account(p_plan) then
    raise exception using errcode = '42501', message = 'Нет доступа к редактированию плана';
  end if;
  select * into settings from expense_tracking.plans where id=p_plan;
  if p_action='enable' then
    if settings.id is not null then
      raise exception using errcode='PT409', message='Учет уже включен. Обновите данные.';
    end if;
    if entry_date is null or entry_date > today then raise exception 'Укажите дату начального остатка не позднее сегодняшней'; end if;
    insert into expense_tracking.plans (id,started_on,fact_mode,deposit_account,debit_account)
      values (p_plan,today,p_payload->>'fact_mode',new_id,new_id);
    insert into expense_tracking.accounts (plan_id,id,title,opening_amount,opening_date)
      values (p_plan,new_id,btrim(p_payload->>'title'),(p_payload->>'amount')::numeric,entry_date);
    return public.expense_tracking_get(p_plan);
  end if;
  if settings.id is null then raise exception 'Сначала включите учет расходов'; end if;
  if p_revision is distinct from settings.revision then
    raise exception using errcode='PT409', message='Учет изменился в другой вкладке. Обновите данные.';
  end if;
  if is_family and p_action in ('purchase_save','purchase_delete') then
    select to_jsonb(p) - 'plan_id' into purchase_before from expense_tracking.purchases p
      where (p.plan_id,p.id)=(p_plan,new_id);
  end if;

  if p_action='account_add' then
    if entry_date is null or entry_date > today then raise exception 'Укажите дату начального остатка не позднее сегодняшней'; end if;
    insert into expense_tracking.accounts (plan_id,id,title,opening_amount,opening_date)
      values (p_plan,new_id,btrim(p_payload->>'title'),(p_payload->>'amount')::numeric,entry_date);
  elsif p_action='defaults' then
    account_from := (p_payload->>'debit_account')::uuid;
    account_to := (p_payload->>'deposit_account')::uuid;
    if not exists(select 1 from expense_tracking.accounts where (plan_id,id)=(p_plan,account_from))
       or not exists(select 1 from expense_tracking.accounts where (plan_id,id)=(p_plan,account_to)) then
      raise exception 'Выберите счета этого плана';
    end if;
    update expense_tracking.plans set deposit_account=account_to, debit_account=account_from where id=p_plan;
  elsif p_action='movement_add' then
    entry_amount := (p_payload->>'amount')::numeric;
    if entry_date is null or entry_date>today or entry_amount is null or entry_amount<=0
       or entry_amount<>round(entry_amount,2) or entry_amount>99999999999999 then
      raise exception 'Проверьте дату и сумму движения';
    end if;
    insert into expense_tracking.movements
      values (p_plan,new_id,entry_date,(nullif(p_payload->>'from_account',''))::uuid,
        (p_payload->>'to_account')::uuid,entry_amount,entry_note);
  elsif p_action='purchase_delete' then
    delete from expense_tracking.purchases where (plan_id,id)=(p_plan,new_id);
    if not found then raise exception 'Покупка не найдена'; end if;
  elsif p_action='purchase_save' then
    entry_amount := (p_payload->>'amount')::numeric;
    if entry_amount is null or entry_amount <= 0 or entry_amount <> round(entry_amount,2) or entry_amount > 99999999999999
      or entry_date is null or entry_date > today or not isfinite(entry_date) then
      raise exception 'Проверьте сумму и дату покупки';
    end if;
    if is_family then
      select c.title, coalesce(i.title,'') into category_name,item_name
        from public.family_categories c left join public.family_categories i
          on i.family_id=c.family_id and i.parent_id=c.id and i.id=item and not i.archived
        where c.family_id=p_plan and c.id=category and c.parent_id is null and not c.archived;
    else
      select c.title, coalesce(i.title,'') into category_name,item_name
        from public.expense_categories c left join public.expense_items i
          on i.account_id=c.account_id and i.category_id=c.id and i.id=item
        where c.account_id=p_plan and c.id=category;
    end if;
    if category_name is null or (item<>'' and item_name='') then raise exception 'Выберите категорию и статью плана'; end if;

    if jsonb_typeof(p_payload->'parts') is distinct from 'array' then raise exception 'Укажите части оплаты'; end if;
    select count(*),count(distinct s.account_id),sum(s.amount) into existing_count,distinct_count,parts_total
      from jsonb_to_recordset(p_payload->'parts') as s(account_id uuid, amount numeric)
      join expense_tracking.accounts a on (a.plan_id,a.id)=(p_plan,s.account_id)
      where s.amount>0 and s.amount=round(s.amount,2) and s.amount<=entry_amount;
    if existing_count not between 1 and 30 or existing_count<>jsonb_array_length(p_payload->'parts')
       or existing_count<>distinct_count or parts_total<>entry_amount then
      raise exception 'Части оплаты должны совпадать с суммой покупки и использовать разные счета этого плана';
    end if;

    if covered then
      if date_trunc('month',entry_date)>date_trunc('month',settings.started_on)
        or (settings.fact_mode='reset' and date_trunc('month',entry_date)=date_trunc('month',settings.started_on)) then
        raise exception 'За этот месяц нет исходного ручного факта';
      end if;
      if is_family then
        select amount into base_fact from public.family_expense_facts
          where family_id=p_plan and month=to_char(entry_date,'YYYY-MM') and category_id=coalesce(nullif(item,''),category);
      else
        select amount into base_fact from public.expense_facts
          where account_id=p_plan and ym=to_char(entry_date,'YYYY-MM') and category_id=category and item_key=item;
      end if;
      select coalesce(sum(p.total),0) into already_covered from expense_tracking.purchases p where p.plan_id=p_plan
        and p.id<>new_id and p.category_id=category and p.item_id=item and p.included_in_fact
        and p.occurred_on>=date_trunc('month',entry_date)::date and p.occurred_on<(date_trunc('month',entry_date)+interval '1 month')::date;
      if base_fact is null or base_fact-already_covered<entry_amount then
        raise exception 'Сумма покупки больше неразобранного ручного факта за этот месяц';
      end if;
    end if;

    if jsonb_typeof(coalesce(p_payload->'tags','[]'::jsonb)) <> 'array' then raise exception 'Проверьте теги'; end if;
    select coalesce(array_agg(distinct btrim(tag) order by btrim(tag)) filter (where btrim(tag)<>''),'{}')
      into entry_tags from jsonb_array_elements_text(coalesce(p_payload->'tags','[]'::jsonb)) as t(tag);
    if cardinality(entry_tags)>20 or exists(select 1 from unnest(entry_tags) tag where length(tag)>60) then
      raise exception 'Укажите до 20 тегов длиной не более 60 символов';
    end if;
    insert into expense_tracking.purchases
      values (p_plan,new_id,entry_date,category,category_name,item,item_name,entry_amount,covered,entry_tags,entry_note)
      on conflict (plan_id,id) do update set occurred_on=excluded.occurred_on,
        category_id=excluded.category_id,category_title=excluded.category_title,item_id=excluded.item_id,
        item_title=excluded.item_title,total=excluded.total,included_in_fact=excluded.included_in_fact,
        tags=excluded.tags,note=excluded.note;
    delete from expense_tracking.parts where (plan_id,purchase_id)=(p_plan,new_id);
    insert into expense_tracking.parts select p_plan,new_id,s.account_id,s.amount
      from jsonb_to_recordset(p_payload->'parts') as s(account_id uuid,amount numeric);
  else
    raise exception 'Неизвестное действие учета расходов';
  end if;
  if is_family and p_action in ('purchase_save','purchase_delete') then
    select to_jsonb(p) - 'plan_id' into purchase_after from expense_tracking.purchases p
      where (p.plan_id,p.id)=(p_plan,new_id);
    insert into public.family_audit(family_id,actor_id,actor_name,actor_kind,action,object_type,object_id,before_data,after_data)
      values(p_plan,auth.uid(),coalesce(nullif(family_actor.nickname,''),family_actor.email),'user',
        case when purchase_before is null then 'INSERT' when purchase_after is null then 'DELETE' else 'UPDATE' end,
        'expense_purchase',new_id::text,purchase_before,purchase_after);
  end if;
  update expense_tracking.plans set revision=revision+1 where id=p_plan;
  return public.expense_tracking_get(p_plan);
end;
$$;

revoke execute on function public.expense_tracking_get(uuid),
  public.expense_tracking_command(uuid,text,jsonb,bigint) from public, anon;
grant execute on function public.expense_tracking_get(uuid),
  public.expense_tracking_command(uuid,text,jsonb,bigint) to authenticated;
