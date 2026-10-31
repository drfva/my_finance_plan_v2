-- Семейный бюджет: отдельные данные, закрытый журнал источников, атомарное API.
-- Выполнять после v2/sql/001_schema.sql ... 010_sick_period_split.sql.
begin;

create schema if not exists family_api;
revoke all on schema family_api from public, anon;
grant usage on schema family_api to authenticated, service_role;

alter table public.accounts add column if not exists plan_kind text not null default 'personal'
  check (plan_kind in ('personal', 'family'));

create table if not exists public.families (
  id uuid primary key references public.accounts(id) on delete restrict,
  timezone text not null default 'Europe/Moscow' check (timezone = 'Europe/Moscow'),
  version bigint not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  nickname text not null default '',
  color text not null default 'blue' check (color in ('blue','pink','purple','green','orange')),
  role text not null default 'owner' check (role = 'owner'),
  active boolean not null default true,
  source_account_id uuid references public.accounts(id) on delete restrict,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  revision bigint not null default 0
);
create unique index if not exists family_one_active_per_user on public.family_members(user_id) where active;
create index if not exists family_members_family_idx on public.family_members(family_id);
create index if not exists family_members_source_idx on public.family_members(source_account_id);
create unique index if not exists family_one_active_source on public.family_members(source_account_id) where active and source_account_id is not null;

create table if not exists public.family_contribution_rules (
  member_id uuid not null references public.family_members(id) on delete restrict,
  revision bigint not null,
  effective_from date not null,
  rule jsonb not null,
  created_at timestamptz not null default now(),
  primary key (member_id, revision)
);
create table if not exists public.family_contributions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  member_id uuid not null references public.family_members(id) on delete restrict,
  source_account_id uuid not null references public.accounts(id) on delete restrict,
  period_id text not null,
  pay_date date not null,
  amount numeric not null check (amount >= 0),
  current_amount numeric not null default 0 check (current_amount >= 0),
  arrears_amount numeric not null default 0 check (arrears_amount >= 0),
  settlements jsonb not null default '[]',
  status text not null check (status in ('forecast','posted')),
  available_before numeric not null default 0,
  ledger_after jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (member_id, period_id),
  check (amount = current_amount + arrears_amount)
);
create unique index if not exists family_one_posted_per_source on public.family_contributions(source_account_id, period_id) where status = 'posted';
create index if not exists family_contributions_month_idx on public.family_contributions(family_id, pay_date);
create table if not exists public.family_contribution_overrides (
  member_id uuid not null references public.family_members(id) on delete restrict,
  period_id text not null,
  amount numeric check (amount >= 0),
  revision bigint not null default 0,
  primary key(member_id,period_id)
);

create table if not exists public.family_categories (
  family_id uuid not null references public.families(id) on delete restrict,
  id text not null,
  title text not null check (length(btrim(title)) between 1 and 160),
  parent_id text,
  sort_order integer not null default 0,
  primary key (family_id, id),
  foreign key (family_id, parent_id) references public.family_categories(family_id, id) on delete cascade,
  check (id is distinct from parent_id)
);
create index if not exists family_categories_parent_idx on public.family_categories(family_id, parent_id);
create table if not exists public.family_monthly_expenses (
  family_id uuid not null,
  category_id text not null,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric not null check (amount >= 0),
  primary key (family_id, category_id, month),
  foreign key (family_id, category_id) references public.family_categories(family_id, id) on delete cascade
);
create table if not exists public.family_expense_facts (
  family_id uuid not null,
  category_id text not null,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric not null check (amount >= 0),
  primary key (family_id, category_id, month),
  foreign key (family_id, category_id) references public.family_categories(family_id, id) on delete cascade
);
create table if not exists public.family_audit (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.families(id) on delete restrict,
  actor_id uuid,
  actor_name text not null,
  actor_kind text not null check (actor_kind in ('user','system')),
  action text not null,
  object_type text not null,
  object_id text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists family_audit_history_idx on public.family_audit(family_id, id desc);
create table if not exists public.family_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  email text not null,
  token_hash text not null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  expires_at timestamptz not null,
  created_by uuid not null,
  accepted_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists family_invites_family_idx on public.family_invitations(family_id);
create table if not exists family_api.mail_outbox (
  invitation_id uuid primary key references public.family_invitations(id),
  token text not null,
  state text not null default 'queued' check (state in ('queued','sending','sent','error')),
  attempts integer not null default 0,
  retry_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  error text,
  sent_at timestamptz
);
alter table family_api.mail_outbox enable row level security;
create table if not exists family_api.requests (
  user_id uuid not null,
  request_id uuid not null,
  action text not null,
  payload jsonb not null,
  response jsonb not null,
  primary key (user_id, request_id)
);
alter table family_api.requests enable row level security;
revoke all on all tables in schema family_api from public, anon, authenticated;

-- Семейные таблицы читаются и меняются только через проверенные операции.
-- Скрытые поля источников не доступны даже владельцу семьи через REST.
do $$ declare t text; begin
  foreach t in array array['families','family_members','family_contribution_rules','family_contributions','family_contribution_overrides',
    'family_categories','family_monthly_expenses','family_expense_facts','family_audit','family_invitations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

insert into public.ref_allocation_stages(code, title, description, default_priority)
values ('family','В семейный план','Ваш взнос в общий месячный бюджет',1000)
on conflict (code) do nothing;

-- Новый семейный этап появляется в личном плане только после подключения.
create or replace function public.create_account(p_title text default 'Мой план',p_currency text default 'RUB',p_calendar text default 'ru')
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); acc uuid; begin
  if uid is null then raise sqlstate 'PT401' using message='Нужно войти в приложение'; end if;
  insert into public.accounts(title,base_currency,calendar_code,created_by)
    values(coalesce(nullif(p_title,''),'Мой план'),p_currency,p_calendar,uid) returning id into acc;
  insert into public.account_members(account_id,user_id,role) values(acc,uid,'owner');
  insert into public.allocation_rules(account_id,stage_code,priority,enabled)
    select acc,code,default_priority,true from public.ref_allocation_stages where code<>'family';
  insert into public.account_settings(account_id,key,value) select acc,key,value from public.ref_setting_defaults where scope='account';
  update public.account_settings set value=to_jsonb(p_currency) where account_id=acc and key='base_currency';
  return acc;
end $$;

create or replace function public.can_edit_account(p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.account_members m join public.accounts a on a.id = m.account_id
    where m.account_id = p_account and m.user_id = (select auth.uid())
      and m.role in ('owner','editor') and a.plan_kind = 'personal');
$$;

create or replace function family_api.require_member(p_family uuid, p_owner boolean default false)
returns public.family_members language plpgsql stable security definer set search_path = '' as $$
declare m public.family_members; begin
  if auth.uid() is null then raise sqlstate 'PT401' using message = 'Нужно войти в приложение'; end if;
  select x.* into m from public.family_members x join public.families f on f.id=x.family_id
    where x.family_id = p_family and x.user_id = auth.uid() and x.active and f.deleted_at is null;
  if m.id is null or p_owner and m.role <> 'owner' then raise sqlstate 'PT403' using message = 'Нет прав на это действие в семье'; end if;
  return m;
end $$;

create or replace function family_api.read(p_family uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m public.family_members; result jsonb; begin
  m := family_api.require_member(p_family);
  select jsonb_build_object('id', f.id, 'title', a.title, 'timezone', f.timezone, 'version', f.version,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'email', x.email, 'nickname', x.nickname,
      'color', x.color, 'role', x.role, 'active', x.active, 'is_self', x.user_id = auth.uid()) order by x.joined_at), '[]')
      from public.family_members x where x.family_id = f.id),
    'contributions', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'member_id', c.member_id,
      'period_id', c.period_id, 'pay_date', c.pay_date, 'amount', c.amount, 'status', c.status,
      'current_amount', c.current_amount, 'arrears_amount', c.arrears_amount,
      'settlements', c.settlements) order by c.pay_date, c.id), '[]') from public.family_contributions c
      where c.family_id = f.id and (c.amount > 0 or c.member_id=m.id and c.status='forecast')),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c) - 'family_id' order by c.sort_order, c.id),'[]') from public.family_categories c where c.family_id = f.id),
    'monthly_expenses', (select coalesce(jsonb_agg(to_jsonb(c) - 'family_id' order by c.month,c.category_id),'[]') from public.family_monthly_expenses c where c.family_id = f.id),
    'expense_facts', (select coalesce(jsonb_agg(to_jsonb(c) - 'family_id' order by c.month,c.category_id),'[]') from public.family_expense_facts c where c.family_id = f.id),
    'audit', (select coalesce(jsonb_agg(x order by x.id desc),'[]') from (select au.* from public.family_audit au where au.family_id = f.id order by au.id desc limit 200) x),
    'invitations', case when m.role = 'owner' then (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,
      'status',i.status,'expires_at',i.expires_at,'delivery',o.state,'delivery_error',o.error) order by i.created_at desc),'[]')
      from public.family_invitations i left join family_api.mail_outbox o on o.invitation_id = i.id where i.family_id = f.id) else '[]'::jsonb end)
  into result from public.families f join public.accounts a on a.id = f.id where f.id = p_family;
  return result;
end $$;

create or replace function family_api.personal_context(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m public.family_members; own jsonb; begin
  if auth.uid() is null or not public.is_account_member(p_account) then raise sqlstate 'PT403' using message = 'Нет доступа к плану'; end if;
  select * into m from public.family_members where user_id = auth.uid() and active;
  own := jsonb_build_object('membership', case when m.id is not null then to_jsonb(m) else null end,
    'rules', (select coalesce(jsonb_agg(r.rule || jsonb_build_object('effective_from',r.effective_from,'revision',r.revision) order by r.revision),'[]')
      from public.family_contribution_rules r where r.member_id = m.id),
    'overrides', (select coalesce(jsonb_agg(to_jsonb(o) order by o.period_id),'[]') from public.family_contribution_overrides o where o.member_id=m.id),
    'contributions', (select coalesce(jsonb_agg(case when member.user_id=auth.uid() then to_jsonb(c)
      else jsonb_build_object('member_id',c.member_id,'period_id',c.period_id,'pay_date',c.pay_date,'amount',c.amount,
        'current_amount',c.amount,'arrears_amount',0,'settlements','[]'::jsonb,'status',c.status,'external',true) end order by c.pay_date,c.id),'[]')
      from public.family_contributions c join public.family_members member on member.id = c.member_id
      where c.source_account_id = p_account and (c.status = 'posted' or member.user_id is distinct from auth.uid() and member.active)));
  return jsonb_build_object('family_available',true,'family_private',own,
    'family_source_connected',exists(select 1 from public.family_members x where x.source_account_id=p_account and x.active),
    'family_connection',case when m.id is not null then jsonb_build_object('id',m.family_id,'member_id',m.id,
      'source_account_id',m.source_account_id,'title',(select a.title from public.accounts a where a.id = m.family_id)) else null end);
end $$;

-- Сохраняем старый безопасный invoker API, добавляя новый контекст поверх него.
do $$ begin
  if to_regprocedure('api_private.state_get_personal_base(uuid)') is null then
    alter function public.state_get(uuid) set schema api_private;
    alter function api_private.state_get(uuid) rename to state_get_personal_base;
  end if;
end $$;
create or replace function public.state_get(p_account uuid default null)
returns jsonb language plpgsql stable set search_path = '' as $$
declare s jsonb; kind text; begin
  s := api_private.state_get_personal_base(p_account);
  if s->'account' is null then return s; end if;
  select a.plan_kind into kind from public.accounts a where a.id = (s#>>'{account,id}')::uuid;
  s := jsonb_set(s,'{account,plan_kind}',to_jsonb(kind));
  s := s || jsonb_build_object('accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'role',m.role,'plan_kind',a.plan_kind) order by m.added_at,a.id),'[]')
    from public.accounts a join public.account_members m on m.account_id=a.id where m.user_id=auth.uid()));
  s := s || family_api.personal_context((s#>>'{account,id}')::uuid);
  if kind = 'family' then s := s || jsonb_build_object('family',family_api.read((s#>>'{account,id}')::uuid)); end if;
  return s;
end $$;

create or replace function family_api.audit_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare b jsonb; a jsonb; f uuid; author text; object_id text; begin
  if tg_op <> 'INSERT' then b := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then a := to_jsonb(new); end if;
  if a is not distinct from b then return coalesce(new,old); end if;
  if tg_table_name = 'family_contributions' and coalesce(a->>'status',b->>'status') <> 'posted' then return coalesce(new,old); end if;
  f := coalesce(a->>'family_id',b->>'family_id')::uuid;
  author := coalesce((select coalesce(nullif(m.nickname,''),m.email) from public.family_members m
    where m.family_id = f and m.user_id = auth.uid() order by m.joined_at desc limit 1),
    (select u.email from auth.users u where u.id=auth.uid()),'Система');
  object_id := coalesce(a->>'id',b->>'id',concat(coalesce(a->>'category_id',b->>'category_id'),':',coalesce(a->>'month',b->>'month')));
  if tg_table_name = 'family_members' then b := b - 'source_account_id' - 'revision'; a := a - 'source_account_id' - 'revision'; end if;
  if tg_table_name = 'family_invitations' then b := b - 'token_hash'; a := a - 'token_hash'; end if;
  if tg_table_name = 'family_contributions' then
    b := b - 'source_account_id' - 'available_before' - 'ledger_after';
    a := a - 'source_account_id' - 'available_before' - 'ledger_after';
  end if;
  if b is not distinct from a then return coalesce(new,old); end if;
  insert into public.family_audit(family_id,actor_id,actor_name,actor_kind,action,object_type,object_id,before_data,after_data)
  values(f,auth.uid(),author,case when auth.uid() is null then 'system' else 'user' end,tg_op,tg_table_name,object_id,b,a);
  return coalesce(new,old);
end $$;
do $$ declare t text; begin
  foreach t in array array['family_members','family_categories','family_monthly_expenses','family_expense_facts','family_contributions','family_invitations'] loop
    execute format('drop trigger if exists family_audit_trigger on public.%I',t);
    execute format('create trigger family_audit_trigger after insert or update or delete on public.%I for each row execute function family_api.audit_change()',t);
  end loop;
end $$;

create or replace function family_api.command(p_action text, p_family uuid, p_payload jsonb,
  p_version bigint, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); m public.family_members; prior family_api.requests;
  result jsonb; acc uuid; current_version bigint; v_rule jsonb; source uuid; parent text;
  invitation public.family_invitations; target public.family_members; v_token text; v_email text;
  active_count integer; return_account uuid; old_title text; override_version bigint;
begin
  if uid is null then raise sqlstate 'PT401' using message = 'Нужно войти'; end if;
  if p_request is null or jsonb_typeof(p_payload) <> 'object' then raise sqlstate 'PT400' using message = 'Неверная команда'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  select * into prior from family_api.requests where user_id = uid and request_id = p_request;
  if found then
    if prior.action <> p_action or prior.payload is distinct from jsonb_build_object('family',p_family,'data',p_payload) then
      raise sqlstate 'PT409' using message = 'Идентификатор запроса уже использован';
    end if;
    return prior.response;
  end if;
  if p_action = 'create' then
    if exists(select 1 from public.family_members where user_id = uid and active) then raise sqlstate 'PT409' using message = 'Вы уже состоите в семье'; end if;
    if length(btrim(coalesce(p_payload->>'title',''))) not between 1 and 160 then raise sqlstate 'PT400' using message = 'Укажите название семьи'; end if;
    if not exists(select 1 from public.accounts a join public.account_members am on am.account_id=a.id where am.user_id=uid and am.role='owner' and a.plan_kind='personal') then
      perform public.create_account('Мой личный план','RUB','ru');
    end if;
    acc := public.create_account(btrim(p_payload->>'title'),'RUB','ru');
    update public.accounts set plan_kind = 'family' where id = acc;
    insert into public.families(id) values(acc);
    insert into public.family_members(family_id,user_id,email,role)
      select acc,uid,u.email,'owner' from auth.users u where u.id = uid;
    result := jsonb_build_object('family_id',acc);
  elsif p_action = 'accept' then
    select * into invitation from public.family_invitations i
      where i.token_hash=encode(sha256(convert_to(coalesce(p_payload->>'token',''),'UTF8')),'hex');
    if invitation.id is null then raise sqlstate 'PT404' using message='Приглашение не найдено'; end if;
    perform 1 from public.families where id=invitation.family_id and deleted_at is null for update;
    if not found then raise sqlstate 'PT404' using message='Семейный план удалён'; end if;
    select * into invitation from public.family_invitations where id=invitation.id for update;
    select lower(u.email) into v_email from auth.users u where u.id=uid and u.email_confirmed_at is not null;
    if v_email is null or v_email<>invitation.email then raise sqlstate 'PT403' using message='Войдите с подтверждённой почтой, на которую отправлено приглашение'; end if;
    if invitation.status='accepted' and invitation.accepted_by=uid
      and exists(select 1 from public.family_members x where x.family_id=invitation.family_id and x.user_id=uid and x.active) then
      return jsonb_build_object('family_id',invitation.family_id);
    end if;
    if invitation.status<>'pending' or invitation.expires_at<=now() then raise sqlstate 'PT409' using message='Приглашение отозвано, использовано или срок истёк. Попросите новое'; end if;
    if exists(select 1 from public.family_members where user_id=uid and active) then raise sqlstate 'PT409' using message='Вы уже состоите в семье'; end if;
    if not exists(select 1 from public.accounts a join public.account_members am on am.account_id=a.id where am.user_id=uid and am.role='owner' and a.plan_kind='personal') then
      perform public.create_account('Мой личный план','RUB','ru');
    end if;
    insert into public.family_members(family_id,user_id,email,role) values(invitation.family_id,uid,v_email,'owner');
    insert into public.account_members(account_id,user_id,role) values(invitation.family_id,uid,'owner');
    update public.family_invitations set status='accepted',accepted_by=uid where id=invitation.id;
    update public.families set version=version+1 where id=invitation.family_id;
    result:=jsonb_build_object('family_id',invitation.family_id);
  else
    m := family_api.require_member(p_family);
    select version into current_version from public.families where id = p_family for update;
    if p_action not in ('rule','profile','override') and (p_version is null or p_version <> current_version) then
      raise sqlstate 'PT409' using message = 'Семейный план уже изменился. Обновите данные и повторите правку';
    end if;
    if p_action = 'category' then
      parent := nullif(p_payload->>'parent_id','');
      if parent is not null and not exists(select 1 from public.family_categories c where c.family_id = p_family and c.id = parent and c.parent_id is null) then
        raise sqlstate 'PT400' using message = 'Для подстатьи выберите существующую категорию';
      end if;
      insert into public.family_categories(family_id,id,title,parent_id,sort_order)
        values(p_family,p_payload->>'id',btrim(p_payload->>'title'),parent,coalesce((p_payload->>'sort_order')::integer,0))
        on conflict(family_id,id) do update set title=excluded.title;
    elsif p_action = 'delete_category' then
      delete from public.family_categories where family_id = p_family and id = p_payload->>'id';
    elsif p_action in ('expense','fact') then
      if p_action = 'expense' then
        if p_payload->>'amount' is null then
          delete from public.family_monthly_expenses where family_id = p_family and category_id = p_payload->>'category_id' and month = p_payload->>'month';
        else
          insert into public.family_monthly_expenses(family_id,category_id,month,amount)
            values(p_family,p_payload->>'category_id',p_payload->>'month',(p_payload->>'amount')::numeric)
            on conflict(family_id,category_id,month) do update set amount=excluded.amount;
        end if;
      else
        if p_payload->>'amount' is null then
          delete from public.family_expense_facts where family_id = p_family and category_id = p_payload->>'category_id' and month = p_payload->>'month';
        else
          insert into public.family_expense_facts(family_id,category_id,month,amount)
            values(p_family,p_payload->>'category_id',p_payload->>'month',(p_payload->>'amount')::numeric)
            on conflict(family_id,category_id,month) do update set amount=excluded.amount;
        end if;
      end if;
    elsif p_action = 'profile' then
      if char_length(btrim(coalesce(p_payload->>'nickname','')))>40 then raise sqlstate 'PT400' using message='Никнейм — до 40 символов'; end if;
      update public.family_members set nickname=btrim(coalesce(p_payload->>'nickname','')),color=p_payload->>'color'
        where id = m.id;
    elsif p_action = 'rename' then
      if char_length(btrim(coalesce(p_payload->>'title',''))) not between 1 and 160 then raise sqlstate 'PT400' using message='Укажите название семьи до 160 символов'; end if;
      select a.title into old_title from public.accounts a where a.id=p_family;
      update public.accounts set title=btrim(p_payload->>'title') where id=p_family;
      if old_title is distinct from btrim(p_payload->>'title') then
        insert into public.family_audit(family_id,actor_id,actor_name,actor_kind,action,object_type,object_id,before_data,after_data)
        values(p_family,uid,coalesce(nullif(m.nickname,''),m.email),'user','UPDATE','families',p_family::text,
          jsonb_build_object('title',old_title),jsonb_build_object('title',btrim(p_payload->>'title')));
      end if;
    elsif p_action = 'invite' then
      v_email:=lower(btrim(p_payload->>'email'));
      if v_email is null or v_email!~'^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email)>254 then raise sqlstate 'PT400' using message='Укажите корректную почту'; end if;
      if exists(select 1 from public.family_members where family_id=p_family and active and lower(email)=v_email) then raise sqlstate 'PT409' using message='Этот участник уже в семье'; end if;
      update public.family_invitations set status='revoked' where family_id=p_family and email=v_email and status='pending' and expires_at<=now();
      if not exists(select 1 from public.family_invitations where family_id=p_family and email=v_email and status='pending') then
        v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
        insert into public.family_invitations(family_id,email,token_hash,expires_at,created_by)
          values(p_family,v_email,encode(sha256(convert_to(v_token,'UTF8')),'hex'),now()+interval '7 days',uid) returning * into invitation;
        insert into family_api.mail_outbox(invitation_id,token) values(invitation.id,v_token);
      end if;
    elsif p_action = 'revoke' then
      update public.family_invitations set status='revoked' where id=(p_payload->>'id')::uuid and family_id=p_family and status='pending';
    elsif p_action in ('remove','leave') then
      if p_action='leave' then target:=m;
      else
        select * into target from public.family_members where family_id=p_family and id=(p_payload->>'id')::uuid and active;
        if target.id is null or target.id=m.id then raise sqlstate 'PT400' using message='Участник не найден. Для собственного выхода используйте «Выйти из семьи»'; end if;
      end if;
      select count(*) into active_count from public.family_members where family_id=p_family and active;
      if active_count=1 and coalesce((p_payload->>'confirm_delete')::boolean,false)=false then
        raise sqlstate 'PT409' using message='Вы последний участник. Выход удалит семейный план — подтвердите удаление';
      end if;
      update public.family_members set active=false,left_at=now(),revision=revision+1 where id=target.id;
      delete from public.account_members where account_id=p_family and user_id=target.user_id;
      delete from public.family_contributions where member_id=target.id and status='forecast';
      if active_count=1 then
        update public.families set deleted_at=now() where id=p_family;
        update public.family_invitations set status='revoked' where family_id=p_family and status='pending';
        insert into public.family_audit(family_id,actor_id,actor_name,actor_kind,action,object_type,object_id,before_data,after_data)
          select p_family,uid,coalesce(nullif(m.nickname,''),m.email),'user','DELETE','families',p_family::text,
            jsonb_build_object('title',a.title),jsonb_build_object('deleted',true) from public.accounts a where a.id=p_family;
      end if;
      if p_action='leave' then
        select a.id into return_account from public.accounts a join public.account_members am on am.account_id=a.id
          where am.user_id=uid and a.plan_kind='personal' order by (am.role='owner') desc,am.added_at,a.id limit 1;
        if return_account is null then return_account:=public.create_account('Мой план','RUB','ru'); end if;
      end if;
    elsif p_action = 'override' then
      select o.revision into override_version from public.family_contribution_overrides o where o.member_id=m.id and o.period_id=p_payload->>'period_id' for update;
      override_version:=coalesce(override_version,0);
      if (p_payload->>'revision')::bigint is distinct from override_version then raise sqlstate 'PT409' using message='Этот будущий взнос уже изменился — обновите данные'; end if;
      if (p_payload->>'source_account_id')::uuid is distinct from m.source_account_id or not public.can_edit_account(m.source_account_id) or not exists(select 1 from public.periods p where p.account_id=m.source_account_id
        and p.id=p_payload->>'period_id' and not p.locked and p.pay_date>(now() at time zone 'Europe/Moscow')::date) then
        raise sqlstate 'PT403' using message='Можно исправлять только свои будущие незафиксированные взносы';
      end if;
      insert into public.family_contribution_overrides(member_id,period_id,amount,revision)
        values(m.id,p_payload->>'period_id',(p_payload->>'amount')::numeric,override_version+1)
        on conflict(member_id,period_id) do update set amount=excluded.amount,revision=excluded.revision;
      update public.family_members set revision=revision+1 where id=m.id;
      delete from public.family_contributions where member_id=m.id and status='forecast';
    elsif p_action = 'rule' then
      select * into m from public.family_members where id=m.id for update;
      if (p_payload->>'revision')::bigint is distinct from m.revision then raise sqlstate 'PT409' using message='Ваше правило уже изменилось, обновите страницу'; end if;
      source := (p_payload->>'source_account_id')::uuid;
      if not public.can_edit_account(source) or not exists(select 1 from public.accounts a where a.id=source and a.plan_kind='personal' and a.base_currency='RUB') then
        raise sqlstate 'PT403' using message='Выберите доступный личный план в RUB';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(source::text,1));
      if exists(select 1 from public.family_members x where x.source_account_id=source and x.active and x.id<>m.id) then
        raise sqlstate 'PT409' using message='Этот личный план уже используется как источник взносов. Выберите другой';
      end if;
      if m.source_account_id is not null and m.source_account_id <> source
        and exists(select 1 from public.family_contributions c where c.member_id=m.id and c.status='posted') then
        raise sqlstate 'PT409' using message='После проведения взносов источник этой семьи защищён от замены';
      end if;
      v_rule := p_payload->'rule';
      if jsonb_typeof(v_rule) is distinct from 'object' or v_rule->>'mode' is null
        or v_rule->>'mode' not in ('per_payment','monthly','percent','remainder')
        or v_rule->>'effective_from' is null or (v_rule->>'effective_from')::date < (now() at time zone 'Europe/Moscow')::date then
        raise sqlstate 'PT400' using message='Выберите способ взноса и дату не раньше сегодняшней';
      end if;
      if exists(select 1 from jsonb_each(v_rule) x where x.key in ('amount','percent','limit_amount','limit_percent','cap_per_payment')
        and x.value <> 'null'::jsonb and ((x.value#>>'{}')::numeric < 0 or (x.value#>>'{}')::numeric > 1000000000000))
        or coalesce((v_rule->>'percent')::numeric,0)>100 or coalesce((v_rule->>'limit_percent')::numeric,0)>100
        or coalesce(v_rule->>'limit_scope','payment') not in ('payment','month') then
        raise sqlstate 'PT400' using message='Проверьте суммы, проценты и период лимита';
      end if;
      if m.source_account_id is distinct from source then
        insert into public.allocation_rules(account_id,stage_code,priority,enabled,params)
          select source,'family',coalesce(max(r.priority),0)+1,true,'{}'::jsonb from public.allocation_rules r where r.account_id=source and r.stage_code<>'family'
          on conflict(account_id,stage_code) do update set priority=excluded.priority,enabled=true;
        insert into public.state_versions(account_id,domain,version) values(source,'settings',1)
          on conflict(account_id,domain) do update set version=public.state_versions.version+1;
      end if;
      update public.family_members set source_account_id=source,revision=revision+1 where id=m.id;
      delete from public.family_contribution_rules r where r.member_id=m.id and r.effective_from >= (v_rule->>'effective_from')::date;
      insert into public.family_contribution_rules(member_id,revision,effective_from,rule)
        values(m.id,m.revision+1,(v_rule->>'effective_from')::date,v_rule-'effective_from');
      delete from public.family_contributions c where c.member_id=m.id and c.status='forecast';
    else
      raise sqlstate 'PT400' using message='Неизвестная семейная команда';
    end if;
    if p_action not in ('rule','override') then update public.families set version=version+1 where id=p_family; end if;
    result := jsonb_build_object('family_id',p_family);
    if return_account is not null then result:=result||jsonb_build_object('return_account_id',return_account); end if;
  end if;
  insert into family_api.requests(user_id,request_id,action,payload,response)
    values(uid,p_request,p_action,jsonb_build_object('family',p_family,'data',p_payload),result);
  return result;
end $$;
create or replace function public.family_command(p_action text, p_family uuid, p_payload jsonb,
  p_version bigint, p_request uuid)
returns jsonb language sql set search_path = '' as $$
  select family_api.command(p_action,p_family,p_payload,p_version,p_request);
$$;
create or replace function public.family_get(p_family uuid)
returns jsonb language sql stable set search_path = '' as $$ select family_api.read(p_family); $$;

create or replace function family_api.history(p_family uuid,p_before bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform family_api.require_member(p_family);
  return (select coalesce(jsonb_agg(x order by x.id desc),'[]') from (
    select a.* from public.family_audit a where a.family_id=p_family and (p_before is null or a.id<p_before)
    order by a.id desc limit 100
  ) x);
end $$;
create or replace function public.family_history(p_family uuid,p_before bigint default null)
returns jsonb language sql stable set search_path='' as $$ select family_api.history(p_family,p_before); $$;

create or replace function family_api.worker_members(p_actor uuid, p_after uuid default null,p_source uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.id order by x.id),'[]') from (
    select m.id from public.family_members m where m.active and m.source_account_id is not null
      and (p_actor is null or p_source is null and m.user_id=p_actor or p_source=m.source_account_id and exists(
        select 1 from public.account_members am where am.account_id=p_source and am.user_id=p_actor and am.role in ('owner','editor')))
      and (p_after is null or m.id>p_after)
      and exists(select 1 from public.family_contribution_rules r where r.member_id=m.id)
    order by m.id limit 10
  ) x;
$$;

create or replace function family_api.mail_claim(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; v_lease uuid; result jsonb:='[]'; begin
  for r in select o.invitation_id,o.token,i.email from family_api.mail_outbox o
    join public.family_invitations i on i.id=o.invitation_id
    where i.status='pending' and i.expires_at>now()
      and (p_actor is null or exists(select 1 from public.family_members m where m.family_id=i.family_id and m.user_id=p_actor and m.active and m.role='owner'))
      and (o.state in ('queued','error') and o.retry_at<=now() or o.state='sending' and o.lease_until<now())
    order by o.retry_at,o.invitation_id for update of o skip locked limit 10 loop
    v_lease:=gen_random_uuid();
    update family_api.mail_outbox set state='sending',lease_until=now()+interval '5 minutes',lease_token=v_lease,attempts=attempts+1 where invitation_id=r.invitation_id;
    result:=result||jsonb_build_array(jsonb_build_object('id',r.invitation_id,'email',r.email,'token',r.token,'lease',v_lease));
  end loop;
  return result;
end $$;
create or replace function family_api.mail_ack(p_invitation uuid,p_lease uuid,p_error text)
returns void language plpgsql security definer set search_path='' as $$
begin
  update family_api.mail_outbox set state=case when p_error is null then 'sent' else 'error' end,
    error=left(p_error,100),sent_at=case when p_error is null then now() else sent_at end,
    retry_at=now()+make_interval(mins=>least(60,attempts*attempts)),lease_until=null,lease_token=null
    where invitation_id=p_invitation and lease_token=p_lease;
end $$;
create or replace function family_api.worker_read(p_member uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.family_members; s jsonb; original_uid text; begin
  select * into m from public.family_members where id=p_member and active;
  if m.id is null or p_actor is not null and m.user_id is distinct from p_actor and not exists(
    select 1 from public.account_members am where am.account_id=m.source_account_id and am.user_id=p_actor and am.role in ('owner','editor'))
    then raise sqlstate 'PT403' using message='Нет доступа к источнику взносов'; end if;
  original_uid := current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',m.user_id::text,true);
  if not public.can_edit_account(m.source_account_id) then raise sqlstate 'PT403' using message='Личный источник больше не доступен'; end if;
  s := public.state_get(m.source_account_id);
  perform set_config('request.jwt.claim.sub',coalesce(original_uid,''),true);
  return s || jsonb_build_object('family_job_revision',m.revision);
end $$;

create or replace function family_api.worker_commit(p_member uuid, p_revision bigint,
  p_versions jsonb, p_rows jsonb, p_freeze jsonb, p_post boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m public.family_members; f uuid; v record; version_now bigint; row_data jsonb;
  actual_date date := (now() at time zone 'Europe/Moscow')::date;
  changes integer := 0; count_posted integer := 0; n integer;
begin
  select family_id into f from public.family_members where id=p_member;
  perform 1 from public.families where id=f for update;
  select * into m from public.family_members where id=p_member for update;
  if m.id is null or not m.active or m.revision <> p_revision then raise sqlstate 'PT409' using message='Правило или участие изменилось во время расчёта'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_typeof(p_versions) <> 'object' then raise sqlstate 'PT400' using message='Неверный расчёт'; end if;
  for v in select key,value from jsonb_each_text(p_versions) order by key loop
    insert into public.state_versions(account_id,domain) values(m.source_account_id,v.key) on conflict do nothing;
    select version into version_now from public.state_versions where account_id=m.source_account_id and domain=v.key for update;
    if version_now <> v.value::bigint then raise sqlstate 'PT409' using message='Личный план изменился во время расчёта'; end if;
  end loop;
  if not exists(select 1 from public.accounts where id=m.source_account_id and base_currency='RUB' and plan_kind='personal') then raise sqlstate 'PT400' using message='Источник должен быть в RUB'; end if;
  if p_post then
    -- Все фиксации и семейные поступления записываются в одной транзакции.
    changes := api_private.upsert(m.source_account_id,'periods',coalesce(p_freeze->'periods','[]'),null);
    if changes>0 then update public.state_versions set version=version+1,updated_at=now() where account_id=m.source_account_id and domain='income'; end if;
    changes := api_private.upsert(m.source_account_id,'savings_period_overrides',coalesce(p_freeze->'savings_period_overrides','[]'),null);
    if changes>0 then update public.state_versions set version=version+1,updated_at=now() where account_id=m.source_account_id and domain='savings'; end if;
    changes := api_private.upsert(m.source_account_id,'credit_payment_overrides',coalesce(p_freeze->'credit_payment_overrides','[]'),null);
    if changes>0 then update public.state_versions set version=version+1,updated_at=now() where account_id=m.source_account_id and domain='debts'; end if;
  end if;
  delete from public.family_contributions where member_id=m.id and status='forecast';
  for row_data in select value from jsonb_array_elements(p_rows) loop
    if not exists(select 1 from public.periods p where p.account_id=m.source_account_id and p.id=row_data->>'period_id'
      and p.pay_date=(row_data->>'pay_date')::date) then raise sqlstate 'PT409' using message='Исходная выплата изменилась'; end if;
    if exists(select 1 from public.family_contributions c where c.source_account_id=m.source_account_id
      and c.period_id=row_data->>'period_id' and c.status='posted') then continue; end if;
    insert into public.family_contributions(family_id,member_id,source_account_id,period_id,pay_date,amount,
      current_amount,arrears_amount,settlements,status,available_before,ledger_after)
    values(f,m.id,m.source_account_id,row_data->>'period_id',(row_data->>'pay_date')::date,(row_data->>'amount')::numeric,
      (row_data->>'current_amount')::numeric,(row_data->>'arrears_amount')::numeric,row_data->'settlements',
      case when p_post and (row_data->>'pay_date')::date<=actual_date and exists(
        select 1 from jsonb_array_elements(coalesce(p_freeze->'periods','[]')) frozen
        where frozen->>'id'=row_data->>'period_id' and (frozen->>'locked')::boolean
      ) then 'posted' else 'forecast' end,
      (row_data->>'available_before')::numeric,row_data->'ledger_after');
    if p_post and (row_data->>'pay_date')::date<=actual_date then count_posted := count_posted+1; end if;
  end loop;
  update public.families set version=version+1 where id=f;
  return jsonb_build_object('posted',count_posted);
end $$;

create or replace function family_api.protect_posted_period()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.family_contributions c where c.source_account_id=old.account_id and c.period_id=old.id and c.status='posted') then
    if tg_op='DELETE' or (to_jsonb(new)-'note'-'title'-'income_manual') is distinct from (to_jsonb(old)-'note'-'title'-'income_manual') then
      raise sqlstate 'PT409' using message='По этой выплате уже проведён семейный взнос. Её сумма, дата и фиксация защищены от изменения';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
drop trigger if exists protect_family_period on public.periods;
create trigger protect_family_period before update or delete on public.periods for each row execute function family_api.protect_posted_period();

create or replace function family_api.protect_source_currency()
returns trigger language plpgsql security definer set search_path = '' as $$
declare acc uuid; bad boolean; begin
  if tg_table_name='accounts' then acc:=new.id; bad:=new.base_currency<>'RUB';
  else acc:=new.account_id; bad:=new.key='base_currency' and new.value<>'"RUB"'::jsonb; end if;
  if bad and exists(select 1 from public.family_members m where m.source_account_id=acc and m.active) then
    raise sqlstate 'PT400' using message='Личный источник семейных взносов должен оставаться в RUB';
  end if;
  return new;
end $$;
drop trigger if exists protect_family_currency on public.accounts;
create trigger protect_family_currency before update on public.accounts for each row execute function family_api.protect_source_currency();
drop trigger if exists protect_family_currency on public.account_settings;
create trigger protect_family_currency before insert or update on public.account_settings for each row execute function family_api.protect_source_currency();

create or replace function public.family_worker_members(p_actor uuid default null,p_after uuid default null,p_source uuid default null)
returns jsonb language sql stable set search_path='' as $$ select family_api.worker_members(p_actor,p_after,p_source); $$;
create or replace function public.family_worker_read(p_member uuid,p_actor uuid default null)
returns jsonb language sql set search_path='' as $$ select family_api.worker_read(p_member,p_actor); $$;
create or replace function public.family_worker_commit(p_member uuid,p_revision bigint,p_versions jsonb,p_rows jsonb,p_freeze jsonb,p_post boolean)
returns jsonb language sql set search_path='' as $$ select family_api.worker_commit(p_member,p_revision,p_versions,p_rows,p_freeze,p_post); $$;
create or replace function public.family_mail_claim(p_actor uuid default null)
returns jsonb language sql set search_path='' as $$ select family_api.mail_claim(p_actor); $$;
create or replace function public.family_mail_ack(p_invitation uuid,p_lease uuid,p_error text default null)
returns void language sql set search_path='' as $$ select family_api.mail_ack(p_invitation,p_lease,p_error); $$;

revoke execute on all functions in schema family_api from public, anon, authenticated, service_role;
grant execute on function family_api.read(uuid), family_api.personal_context(uuid),
  family_api.command(text,uuid,jsonb,bigint,uuid),family_api.history(uuid,bigint) to authenticated;
revoke execute on function public.family_command(text,uuid,jsonb,bigint,uuid), public.family_get(uuid), public.state_get(uuid) from public, anon;
grant execute on function public.family_command(text,uuid,jsonb,bigint,uuid), public.family_get(uuid), public.state_get(uuid) to authenticated;
revoke execute on function public.family_history(uuid,bigint) from public,anon;
grant execute on function public.family_history(uuid,bigint) to authenticated;
grant execute on function family_api.worker_members(uuid,uuid,uuid), family_api.worker_read(uuid,uuid),
  family_api.worker_commit(uuid,bigint,jsonb,jsonb,jsonb,boolean) to service_role;
revoke execute on function public.family_worker_members(uuid,uuid,uuid), public.family_worker_read(uuid,uuid),
  public.family_worker_commit(uuid,bigint,jsonb,jsonb,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.family_worker_members(uuid,uuid,uuid), public.family_worker_read(uuid,uuid),
  public.family_worker_commit(uuid,bigint,jsonb,jsonb,jsonb,boolean) to service_role;
grant execute on function family_api.mail_claim(uuid),family_api.mail_ack(uuid,uuid,text) to service_role;
revoke execute on function public.family_mail_claim(uuid),public.family_mail_ack(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.family_mail_claim(uuid),public.family_mail_ack(uuid,uuid,text) to service_role;
revoke execute on function public.create_account(text,text,text),public.can_edit_account(uuid) from public,anon;
grant execute on function public.create_account(text,text,text),public.can_edit_account(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
