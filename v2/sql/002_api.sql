-- =====================================================================
-- Финансы v2 — API обмена с базой
--
--   state_get([account])                          → всё состояние плана одним JSON
--   state_save(domain, patch, [account], [version]) → запись одного домена
--   bootstrap_user([title])                       → при запуске: создать план, если его нет, и отдать состояние
--
-- Формат данных. Строки таблиц отдаются и принимаются как есть: ключи JSON —
-- это имена колонок (snake_case), account_id не передаётся — его подставляет база.
-- Поэтому то, что пришло из state_get, можно без переделки отправить в state_save.
--
--   {
--     "account":  {...}, "accounts": [...], "user": {...}, "ref": {...},
--     "versions": {"income": 12, ...},
--     "settings": {"account_settings": {...}, "allocation_rules": [...], "fx_rates": [...]},
--     "income":   {"plan_years": [...], "payout_slots": [...], "periods": [...], ...},
--     "expenses": {...}, "debts": {...}, "savings": {...}, "gifts": {...}, "facts": {...}
--   }
--
-- Патч домена — объект «таблица → строки». Правила:
--   * таблица есть в патче  → её содержимое для плана заменяется присланным:
--                             новые строки добавляются, изменённые обновляются,
--                             отсутствующие удаляются (режим replace);
--   * таблицы в патче нет   → она не трогается;
--   * пустой массив         → таблица плана очищается;
--   * в строке нет колонки  → при вставке берётся значение по умолчанию,
--                             при обновлении колонка остаётся прежней.
--   Таблицы в режиме upsert (allocation_rules, fx_rates) только добавляются и
--   обновляются, удалить строку через патч нельзя.
--
-- Домен settings, кроме таблиц, принимает три особых ключа:
--   "account":          {"title": "..."}                 — название плана;
--   "account_settings": {"key": value | null, ...}       — настройки плана, null = вернуть умолчание;
--   "user_settings":    {"key": value | null, ...}       — личные настройки.
--   Ключи сверяются с ref_setting_defaults. Патч только с user_settings
--   доступен и зрителю (viewer): язык интерфейса — его личное дело.
--
-- Конфликты. У каждого домена есть номер версии (state_versions). Если передать
-- p_version, а в базе уже другой номер — сохранение отклоняется с кодом PT409
-- (Supabase отдаёт HTTP 409), в detail лежит актуальная версия. Без p_version
-- проверки нет — последняя запись выигрывает.
--
-- Ответ state_save: {domain, version, changed, stats, tables}. В tables — записанные
-- таблицы целиком, как они теперь лежат в базе (со значениями по умолчанию).
--
-- Ошибки: PT401 — не вошёл, PT403 — нет прав, PT404 — нет плана, PT400 — неверный патч.
-- Весь state_save — одна транзакция: при любой ошибке ничего не записывается.
--
-- Файл идемпотентный. Порядок: 001_schema.sql → 002_api.sql.
-- =====================================================================

-- =====================================================================
-- 1. РЕЕСТР ДОМЕНОВ
-- Какие таблицы входят в какой домен и в каком порядке их писать.
-- load_order: родитель раньше потомка (payout_slots после plan_years и т. д.).
-- stamp_col: колонка, которую база заполняет сама — кто последним менял строку.
-- Новая таблица в домене = строка здесь, код функций не меняется.
-- =====================================================================

create table if not exists public.api_domain_tables (
  table_name text    primary key,
  domain     text    not null check (domain in ('settings','income','expenses','debts','savings','gifts','facts')),
  load_order integer not null,
  mode       text    not null default 'replace' check (mode in ('replace','upsert')),
  stamp_col  text
);

insert into public.api_domain_tables (table_name, domain, load_order, mode, stamp_col) values
  ('allocation_rules',         'settings',  10, 'upsert',  null),
  ('fx_rates',                 'settings',  20, 'upsert',  null),

  ('plan_years',               'income',    10, 'replace', null),
  ('payout_slots',             'income',    20, 'replace', null),
  ('salary_rates',             'income',    30, 'replace', null),
  ('tax_scales',               'income',    40, 'replace', null),
  ('tax_brackets',             'income',    50, 'replace', null),
  ('periods',                  'income',    60, 'replace', null),
  ('extra_incomes',            'income',    70, 'replace', null),
  ('income_history',           'income',    80, 'replace', null),
  ('working_day_overrides',    'income',    90, 'replace', null),
  ('account_calendar_days',    'income',   100, 'replace', null),
  ('vacations',                'income',   110, 'replace', null),
  ('sick_leaves',              'income',   120, 'replace', null),

  ('expense_categories',       'expenses',  10, 'replace', null),
  ('expense_items',            'expenses',  20, 'replace', null),
  ('expense_period_overrides', 'expenses',  30, 'replace', null),

  ('credit_cards',             'debts',     10, 'replace', null),
  ('credit_card_ops',          'debts',     20, 'replace', null),
  ('credit_payment_overrides', 'debts',     30, 'replace', null),
  ('installments',             'debts',     40, 'replace', null),
  ('installment_payments',     'debts',     50, 'replace', null),

  ('goals',                    'savings',   10, 'replace', null),
  ('goal_milestones',          'savings',   20, 'replace', null),
  ('goal_cycles',              'savings',   30, 'replace', null),
  ('goal_cycle_skips',         'savings',   40, 'replace', null),
  ('goal_transactions',        'savings',   50, 'replace', null),
  ('savings_period_overrides', 'savings',   60, 'replace', null),

  ('gift_events',              'gifts',     10, 'replace', null),
  ('gift_event_amounts',       'gifts',     20, 'replace', null),

  ('expense_facts',            'facts',     10, 'replace', 'entered_by')
on conflict (table_name) do update
  set domain = excluded.domain, load_order = excluded.load_order,
      mode = excluded.mode, stamp_col = excluded.stamp_col;

alter table public.api_domain_tables enable row level security;
drop policy if exists read_all on public.api_domain_tables;
create policy read_all on public.api_domain_tables for select to authenticated using (true);
grant select on public.api_domain_tables to authenticated;

-- Справочники читают все вошедшие. Политика задаётся явно: если в проекте
-- Supabase включено автоматическое RLS для новых таблиц, без политики справочники
-- видны пустыми, и приложение не находит ни настроек, ни валют.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' and tablename like 'ref\_%' loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('drop policy if exists read_all on public.%I', r.tablename);
    execute format('create policy read_all on public.%I for select to authenticated using (true)', r.tablename);
    execute format('grant select on public.%I to authenticated', r.tablename);
  end loop;
end $$;

-- =====================================================================
-- 2. ВЕРСИИ ДОМЕНОВ
-- =====================================================================

create table if not exists public.state_versions (
  account_id uuid        not null references public.accounts(id) on delete cascade,
  domain     text        not null,
  version    bigint      not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users(id) on delete set null,
  primary key (account_id, domain)
);

alter table public.state_versions enable row level security;
drop policy if exists member_read on public.state_versions;
create policy member_read on public.state_versions for select to authenticated
  using (public.is_account_member(account_id));
drop policy if exists member_write on public.state_versions;
create policy member_write on public.state_versions for all to authenticated
  using (public.can_edit_account(account_id)) with check (public.can_edit_account(account_id));
grant select, insert, update, delete on public.state_versions to authenticated;

-- =====================================================================
-- 3. СЛУЖЕБНЫЕ ФУНКЦИИ
-- Все функции API работают с правами вызывающего (security invoker), поэтому
-- политики RLS действуют и здесь: даже ошибка в коде не даст записать в чужой план.
-- =====================================================================

create schema if not exists api_private;
revoke all on schema api_private from public, anon;
grant usage on schema api_private to authenticated;

-- Колонки таблицы; p_pk_only — только первичный ключ.
-- Работает только со справочниками и таблицами из реестра доменов: всё остальное —
-- ошибка, даже если служебную функцию вызвали в обход state_save.
create or replace function api_private.cols(p_table text, p_pk_only boolean default false)
returns text[]
language plpgsql stable
set search_path = public, pg_catalog
as $$
declare v_res text[];
begin
  if not (p_table like 'ref\_%' or exists (select 1 from api_domain_tables d where d.table_name = p_table)) then
    perform api_private.fail('PT400', format('Таблица %s недоступна через API', p_table));
  end if;

  select array_agg(a.attname::text order by a.attnum) into v_res
  from pg_attribute a
  where a.attrelid = to_regclass('public.' || quote_ident(p_table))
    and a.attnum > 0 and not a.attisdropped
    and (not p_pk_only or a.attnum = any (
          select unnest(i.indkey::int2[]) from pg_index i
          where i.indrelid = a.attrelid and i.indisprimary));

  if v_res is null then
    perform api_private.fail('PT400', format('Таблица %s не найдена', p_table));
  end if;
  return v_res;
end;
$$;

-- Ошибка с кодом, который Supabase превращает в HTTP-статус
create or replace function api_private.fail(p_code text, p_message text, p_detail text default null)
returns void
language plpgsql
as $$
begin
  raise exception using errcode = p_code, message = p_message, detail = coalesce(p_detail, '');
end;
$$;

-- План, с которым работаем. Не указан — первый план пользователя, свой раньше чужого.
create or replace function api_private.account(p_account uuid)
returns uuid
language plpgsql stable
set search_path = public
as $$
declare v_acc uuid;
begin
  if auth.uid() is null then
    perform api_private.fail('PT401', 'Нужно войти в приложение');
  end if;
  if p_account is not null then
    if not is_account_member(p_account) then
      perform api_private.fail('PT403', 'Нет доступа к этому плану');
    end if;
    return p_account;
  end if;
  select m.account_id into v_acc
  from account_members m
  where m.user_id = auth.uid()
  order by (m.role = 'owner') desc, m.added_at, m.account_id
  limit 1;
  return v_acc;
end;
$$;

-- Проверка строк патча одной таблицы до любых изменений
create or replace function api_private.check_rows(p_table text, p_rows jsonb, p_stamp text)
returns void
language plpgsql stable
set search_path = public
as $$
declare
  v_cols text[] := api_private.cols(p_table);
  v_pk   text[] := array_remove(api_private.cols(p_table, true), 'account_id');
  v_bad  text;
  v_dup  bigint;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    perform api_private.fail('PT400', format('%s: ожидался массив строк', p_table));
  end if;

  if exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) <> 'object') then
    perform api_private.fail('PT400', format('%s: каждая строка должна быть объектом', p_table));
  end if;

  select string_agg(distinct k, ', ') into v_bad
  from jsonb_array_elements(p_rows) e, jsonb_object_keys(e) k
  where k <> all (v_cols);
  if v_bad is not null then
    perform api_private.fail('PT400', format('%s: неизвестные колонки: %s', p_table, v_bad));
  end if;

  select string_agg(distinct pk, ', ') into v_bad
  from jsonb_array_elements(p_rows) e, unnest(v_pk) pk
  where e->>pk is null;
  if v_bad is not null then
    perform api_private.fail('PT400', format('%s: в строке не заполнен ключ: %s', p_table, v_bad));
  end if;

  select count(*) - count(distinct (select jsonb_agg(e->pk order by pk) from unnest(v_pk) pk))
    into v_dup
  from jsonb_array_elements(p_rows) e;
  if v_dup > 0 then
    perform api_private.fail('PT400', format('%s: ключ строки повторяется (%s раз)', p_table, v_dup));
  end if;
end;
$$;

-- Удалить строки плана, которых нет в патче (режим replace)
create or replace function api_private.delete_missing(p_account uuid, p_table text, p_rows jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_pk    text[] := array_remove(api_private.cols(p_table, true), 'account_id');
  v_match text;
  v_n     integer;
begin
  select string_agg(format('r.%1$I = t.%1$I', pk), ' and ') into v_match from unnest(v_pk) pk;

  execute format(
    'delete from public.%1$I t
      where t.account_id = $1
        and not exists (select 1 from jsonb_populate_recordset(null::public.%1$I, $2) r where %2$s)',
    p_table, v_match)
  using p_account, p_rows;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Добавить новые и обновить изменённые строки. Строки без изменений не трогаются.
-- Строки группируются по набору колонок, для каждого набора две команды:
--   update — существующие строки, только присланные колонки и только если что-то отличается;
--   insert — новые строки, отсутствующие колонки получают значения по умолчанию.
-- Поэтому частичная строка ({"stage_code":"gifts","enabled":false}) обновляет одну колонку
-- и не упирается в not null остальных.
create or replace function api_private.upsert(p_account uuid, p_table text, p_rows jsonb, p_stamp text)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_pk    text[] := api_private.cols(p_table, true);
  v_grp   record;
  v_upd   text[];
  v_match text;
  v_n     integer;
  v_total integer := 0;
begin
  select string_agg(format('t.%1$I = r.%1$I', c), ' and ') into v_match from unnest(v_pk) c;

  for v_grp in
    select kk.keys, jsonb_agg(s.r) as rows
    from (
      select (e - 'account_id' - coalesce(p_stamp, '')) || jsonb_build_object('account_id', p_account) as r
      from jsonb_array_elements(p_rows) e
    ) s
    cross join lateral (select array_agg(k order by k) as keys from jsonb_object_keys(s.r) k) kk
    group by kk.keys
  loop
    v_upd := array(select c from unnest(v_grp.keys) c where c <> all (v_pk));

    -- существующие строки
    if cardinality(v_upd) > 0 then
      execute format(
        'update public.%I t set %s%s
           from jsonb_populate_recordset(null::public.%I, $1) r
          where %s and row(%s) is distinct from row(%s)',
        p_table,
        (select string_agg(format('%1$I = r.%1$I', c), ', ') from unnest(v_upd) c),
        case when p_stamp is not null then format(', %I = auth.uid()', p_stamp) else '' end,
        p_table,
        v_match,
        (select string_agg(format('t.%I', c), ', ') from unnest(v_upd) c),
        (select string_agg(format('r.%I', c), ', ') from unnest(v_upd) c))
      using v_grp.rows;
      get diagnostics v_n = row_count;
      v_total := v_total + v_n;
    end if;

    -- новые строки
    execute format(
      'insert into public.%I (%s%s)
       select %s%s from jsonb_populate_recordset(null::public.%I, $1) r
        where not exists (select 1 from public.%I t where %s)',
      p_table,
      (select string_agg(format('%I', c), ', ') from unnest(v_grp.keys) c),
      case when p_stamp is not null then format(', %I', p_stamp) else '' end,
      (select string_agg(format('r.%I', c), ', ') from unnest(v_grp.keys) c),
      case when p_stamp is not null then ', auth.uid()' else '' end,
      p_table, p_table, v_match)
    using v_grp.rows;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;

  return v_total;
end;
$$;

-- Настройки «ключ → значение»: null удаляет ключ, остальное записывается
create or replace function api_private.save_kv(p_account uuid, p_scope text, p_patch jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_bad   text;
  v_n     integer;
  v_total integer := 0;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then
    perform api_private.fail('PT400', format('%s_settings: ожидался объект «ключ → значение»', p_scope));
  end if;

  select string_agg(k, ', ') into v_bad
  from jsonb_object_keys(p_patch) k
  where not exists (select 1 from ref_setting_defaults d where d.key = k and d.scope = p_scope);
  if v_bad is not null then
    perform api_private.fail('PT400', format('%s_settings: неизвестные настройки: %s', p_scope, v_bad));
  end if;

  if p_scope = 'account' then
    delete from account_settings s
    where s.account_id = p_account
      and s.key in (select key from jsonb_each(p_patch) where jsonb_typeof(value) = 'null');
    get diagnostics v_n = row_count; v_total := v_total + v_n;

    insert into account_settings (account_id, key, value)
    select p_account, key, value from jsonb_each(p_patch) where jsonb_typeof(value) <> 'null'
    on conflict (account_id, key) do update set value = excluded.value
      where account_settings.value is distinct from excluded.value;
    get diagnostics v_n = row_count; v_total := v_total + v_n;

    -- базовая валюта и календарь продублированы в accounts: держим их одинаковыми
    update accounts a
       set base_currency = coalesce((select value #>> '{}' from account_settings
                                     where account_id = p_account and key = 'base_currency'),
                                    (select value #>> '{}' from ref_setting_defaults where key = 'base_currency')),
           calendar_code = coalesce((select value #>> '{}' from account_settings
                                     where account_id = p_account and key = 'calendar_code'),
                                    (select value #>> '{}' from ref_setting_defaults where key = 'calendar_code'))
     where a.id = p_account
       and (p_patch ? 'base_currency' or p_patch ? 'calendar_code');
  else
    delete from user_settings s
    where s.user_id = auth.uid()
      and s.key in (select key from jsonb_each(p_patch) where jsonb_typeof(value) = 'null');
    get diagnostics v_n = row_count; v_total := v_total + v_n;

    insert into user_settings (user_id, key, value)
    select auth.uid(), key, value from jsonb_each(p_patch) where jsonb_typeof(value) <> 'null'
    on conflict (user_id, key) do update set value = excluded.value
      where user_settings.value is distinct from excluded.value;
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  end if;

  return v_total;
end;
$$;

-- Все строки таблицы плана одним массивом, без account_id
create or replace function api_private.read_table(p_account uuid, p_table text)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare v_res jsonb;
begin
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t) - ''account_id'' order by %s), ''[]''::jsonb)
       from public.%I t where t.account_id = $1',
    (select string_agg(format('t.%I', c), ', ') from unnest(api_private.cols(p_table, true)) c),
    p_table)
  into v_res using p_account;
  return v_res;
end;
$$;

-- =====================================================================
-- 4. ЧТЕНИЕ
-- =====================================================================

create or replace function public.state_get(p_account uuid default null)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_acc uuid;
  v_ref jsonb := '{}'::jsonb;
  v_dom jsonb;
  v_res jsonb;
  v_t   record;
  r     text;
begin
  v_acc := api_private.account(p_account);

  -- справочники: общие для всех, отдаются целиком
  foreach r in array array[
    'ref_allocation_stages','ref_goal_kinds','ref_expense_modes','ref_split_modes',
    'ref_period_units','ref_currencies','ref_calendars','ref_calendar_days','ref_setting_defaults'
  ] loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) order by %s), ''[]''::jsonb) from public.%I t',
      (select string_agg(format('t.%I', c), ', ') from unnest(api_private.cols(r, true)) c), r)
    into v_dom;
    v_ref := v_ref || jsonb_build_object(substr(r, 5), v_dom);
  end loop;

  v_res := jsonb_build_object(
    'user', jsonb_build_object(
      'id', v_uid,
      'settings', (select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb)
                   from user_settings s where s.user_id = v_uid)),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'role', m.role)
                                           order by (m.role = 'owner') desc, m.added_at, a.id), '[]'::jsonb)
                 from account_members m join accounts a on a.id = m.account_id
                 where m.user_id = v_uid),
    'ref', v_ref,
    'account', null);

  -- плана ещё нет: приложение откроет мастер настройки
  if v_acc is null then
    return v_res;
  end if;

  v_res := v_res || jsonb_build_object(
    'account', (select jsonb_build_object('id', a.id, 'title', a.title, 'base_currency', a.base_currency,
                                          'calendar_code', a.calendar_code, 'role', m.role,
                                          'can_edit', m.role in ('owner','editor'))
                from accounts a join account_members m on m.account_id = a.id and m.user_id = v_uid
                where a.id = v_acc),
    'versions', (select jsonb_object_agg(d.domain, coalesce(sv.version, 0))
                 from (select distinct domain from api_domain_tables) d
                 left join state_versions sv on sv.account_id = v_acc and sv.domain = d.domain),
    'settings', jsonb_build_object(
      'account_settings', (select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb)
                           from account_settings s where s.account_id = v_acc)));

  for v_t in select * from api_domain_tables order by domain, load_order loop
    v_res := jsonb_set(v_res, array[v_t.domain],
               coalesce(v_res -> v_t.domain, '{}'::jsonb)
               || jsonb_build_object(v_t.table_name, api_private.read_table(v_acc, v_t.table_name)));
  end loop;

  return v_res;
end;
$$;

-- =====================================================================
-- 5. ЗАПИСЬ
-- =====================================================================

create or replace function public.state_save(p_domain  text,
                                             p_patch   jsonb,
                                             p_account uuid   default null,
                                             p_version bigint default null)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_acc       uuid;
  v_user_only boolean;
  v_cur       bigint;
  v_new       bigint;
  v_bad       text;
  v_t         record;
  v_n         integer;
  v_changed   integer := 0;
  v_stats     jsonb := '{}'::jsonb;
  v_tables    jsonb := '{}'::jsonb;
begin
  -- 1. что пришло
  if not exists (select 1 from api_domain_tables where domain = p_domain) then
    perform api_private.fail('PT400', format('Неизвестный домен: %s', coalesce(p_domain, 'null')));
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    perform api_private.fail('PT400', 'Патч должен быть объектом «таблица → строки»');
  end if;

  select string_agg(k, ', ') into v_bad
  from jsonb_object_keys(p_patch) k
  where not exists (select 1 from api_domain_tables t where t.domain = p_domain and t.table_name = k)
    and not (p_domain = 'settings' and k in ('account', 'account_settings', 'user_settings'));
  if v_bad is not null then
    perform api_private.fail('PT400', format('В домене %s нет: %s', p_domain, v_bad));
  end if;

  -- 2. чей план и можно ли писать
  v_acc := api_private.account(p_account);
  if v_acc is null then
    perform api_private.fail('PT404', 'План не найден: сначала создайте его');
  end if;

  v_user_only := p_domain = 'settings'
                 and not exists (select 1 from jsonb_object_keys(p_patch) k where k <> 'user_settings');

  if not v_user_only and not can_edit_account(v_acc) then
    perform api_private.fail('PT403', 'У вас доступ только на просмотр этого плана');
  end if;

  -- 3. проверка всех таблиц патча до первой записи
  for v_t in
    select t.* from api_domain_tables t where t.domain = p_domain and p_patch ? t.table_name
  loop
    perform api_private.check_rows(v_t.table_name, p_patch -> v_t.table_name, v_t.stamp_col);
  end loop;

  -- 4. версия домена: блокируем строку, чтобы параллельные сохранения шли по очереди
  if not v_user_only then
    insert into state_versions (account_id, domain) values (v_acc, p_domain)
    on conflict (account_id, domain) do nothing;

    select sv.version into v_cur
    from state_versions sv
    where sv.account_id = v_acc and sv.domain = p_domain
    for update;

    if p_version is not null and p_version <> v_cur then
      perform api_private.fail('PT409',
        format('Данные раздела «%s» уже изменены в другой вкладке или другим участником', p_domain),
        jsonb_build_object('domain', p_domain, 'version', v_cur)::text);
    end if;
  end if;

  -- 5. особые ключи настроек
  if p_domain = 'settings' then
    if p_patch ? 'account' then
      if jsonb_typeof(p_patch -> 'account') is distinct from 'object'
         or exists (select 1 from jsonb_object_keys(p_patch -> 'account') k where k <> 'title') then
        perform api_private.fail('PT400', 'account: можно менять только title');
      end if;
      update accounts a set title = coalesce(nullif(p_patch #>> '{account,title}', ''), a.title)
      where a.id = v_acc and a.title is distinct from coalesce(nullif(p_patch #>> '{account,title}', ''), a.title);
      get diagnostics v_n = row_count;
      v_changed := v_changed + v_n;
      v_stats := v_stats || jsonb_build_object('account', v_n);
    end if;
    if p_patch ? 'account_settings' then
      v_n := api_private.save_kv(v_acc, 'account', p_patch -> 'account_settings');
      v_changed := v_changed + v_n;
      v_stats := v_stats || jsonb_build_object('account_settings', v_n);
    end if;
    if p_patch ? 'user_settings' then
      v_n := api_private.save_kv(v_acc, 'user', p_patch -> 'user_settings');
      v_stats := v_stats || jsonb_build_object('user_settings', v_n);
    end if;
  end if;

  -- 6. удаление: от потомков к родителям
  for v_t in
    select t.* from api_domain_tables t
    where t.domain = p_domain and t.mode = 'replace' and p_patch ? t.table_name
    order by t.load_order desc
  loop
    v_n := api_private.delete_missing(v_acc, v_t.table_name, p_patch -> v_t.table_name);
    v_changed := v_changed + v_n;
    v_stats := v_stats || jsonb_build_object(v_t.table_name, jsonb_build_object('deleted', v_n));
  end loop;

  -- 7. вставка и обновление: от родителей к потомкам
  for v_t in
    select t.* from api_domain_tables t
    where t.domain = p_domain and p_patch ? t.table_name
    order by t.load_order
  loop
    v_n := api_private.upsert(v_acc, v_t.table_name, p_patch -> v_t.table_name, v_t.stamp_col);
    v_changed := v_changed + v_n;
    v_stats := jsonb_set(v_stats, array[v_t.table_name],
                         coalesce(v_stats -> v_t.table_name, '{}'::jsonb) || jsonb_build_object('upserted', v_n));
  end loop;

  -- 8. новая версия, только если что-то действительно поменялось
  v_new := v_cur;
  if not v_user_only and v_changed > 0 then
    update state_versions sv
       set version = sv.version + 1, updated_at = now(), updated_by = v_uid
     where sv.account_id = v_acc and sv.domain = p_domain
    returning sv.version into v_new;
  end if;

  -- 9. записанные таблицы в том виде, в каком они теперь лежат в базе:
  --    со значениями по умолчанию для колонок, которых не было в патче
  for v_t in
    select t.* from api_domain_tables t where t.domain = p_domain and p_patch ? t.table_name
  loop
    v_tables := v_tables || jsonb_build_object(v_t.table_name, api_private.read_table(v_acc, v_t.table_name));
  end loop;

  return jsonb_build_object(
    'domain',     p_domain,
    'account_id', v_acc,
    'version',    v_new,
    'changed',    v_changed,
    'stats',      v_stats,
    'tables',     v_tables);
end;
$$;

-- =====================================================================
-- 6. ПЕРВЫЙ ВХОД
-- bootstrap_user — то, что приложение вызывает при запуске вместо state_get.
-- Нет ни одного плана (ни своего, ни приглашения) — создаёт свой и делает
-- пользователя владельцем. Потом отдаёт состояние, как state_get.
-- Блокировка по пользователю: две вкладки при первом входе не создадут два плана.
-- =====================================================================

create or replace function public.bootstrap_user(p_title text default 'Мой план')
returns jsonb
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    perform api_private.fail('PT401', 'Нужно войти в приложение');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bootstrap_user:' || auth.uid()::text, 0));

  if not exists (select 1 from account_members m where m.user_id = auth.uid()) then
    perform create_account(p_title);
  end if;

  return state_get();
end;
$$;

-- =====================================================================
-- 7. ПРАВА НА ВЫЗОВ
-- Служебные функции лежат в схеме api_private: Supabase её не публикует,
-- поэтому напрямую через API их не вызвать — только изнутри state_get/state_save.
-- =====================================================================

revoke execute on all functions in schema api_private from public, anon;
grant  execute on all functions in schema api_private to authenticated;

revoke execute on function public.state_get(uuid)                       from public, anon;
revoke execute on function public.state_save(text, jsonb, uuid, bigint) from public, anon;
grant  execute on function public.state_get(uuid)                       to authenticated;
grant  execute on function public.state_save(text, jsonb, uuid, bigint) to authenticated;
revoke execute on function public.bootstrap_user(text)                  from public, anon;
grant  execute on function public.bootstrap_user(text)                  to authenticated;
