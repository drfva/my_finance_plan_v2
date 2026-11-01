-- Финансы v2: установка в чистый проект Supabase одним запуском.
-- Требуются auth.users, auth.uid(), роли anon, authenticated, service_role.
-- Сформировано tools/build-install.mjs из v2/sql/001...010 и supabase/migrations.
-- Сброс данных (000_reset_public.sql) не включён.
-- Для существующей базы применяйте отдельную новую миграцию.
begin;

-- SOURCE: v2/sql/001_schema.sql
-- =====================================================================
-- Финансы v2 — схема данных
--
-- Ключевые решения:
--   * данные плана принадлежат АККАУНТУ, а не пользователю: план можно
--     разделить, например с супругом. Пользователь — участник аккаунта;
--   * ни одной константы в коде: справочники и настройки живут в таблицах;
--   * валюты: у аккаунта базовая, у цели может быть своя; курс тянется раз в день;
--   * циклические копилки генерируют этапы и траты, но пользователь может их
--     править и удалять — такие вхождения генератор больше не трогает.
--
-- Файл идемпотентный. Порядок: 001_schema.sql → 002_api.sql.
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
-- 1. СПРАВОЧНИКИ (общие, только чтение)
-- =====================================================================

create table if not exists public.ref_allocation_stages (
  code             text primary key,
  title            text    not null,
  default_priority integer not null,
  description      text    not null default ''
);

insert into public.ref_allocation_stages (code, title, default_priority, description) values
  ('categories',  'Категории расходов', 1, 'Обязательные расходы: фиксированной суммой или процентом от выплаты'),
  ('gifts',       'Подарки',            2, 'Суммы к датам праздников, просрочки быть не должно'),
  ('installments','Рассрочки',          3, 'Платежи по графику покупок в рассрочку'),
  ('credits',     'Кредиты',            4, 'Погашение карт, чтобы уложиться в льготный период'),
  ('buckets',     'Копилки',            5, 'Цели с оборотом: копим к сроку, тратим, копим снова'),
  ('reserves',    'Подушки',            6, 'Накопления без срока, темпом и остатком')
on conflict (code) do update
  set title = excluded.title, default_priority = excluded.default_priority, description = excluded.description;

create table if not exists public.ref_goal_kinds (
  code       text primary key,
  title      text not null,
  stage_code text not null references public.ref_allocation_stages(code)
);

insert into public.ref_goal_kinds (code, title, stage_code) values
  ('bucket',  'Копилка',          'buckets'),
  ('reserve', 'Подушка',          'reserves'),
  ('gifts',   'Копилка подарков', 'gifts')
on conflict (code) do update set title = excluded.title, stage_code = excluded.stage_code;

create table if not exists public.ref_expense_modes (
  code text primary key, title text not null, description text not null default ''
);

insert into public.ref_expense_modes (code, title, description) values
  ('fixed_month',    'Фиксированная сумма в месяц', 'Сумма месяца делится между выплатами месяца'),
  ('percent_income', 'Процент от выплаты на руки',  'С каждой выплаты удерживается процент; за месяц он должен покрыть план категории')
on conflict (code) do update set title = excluded.title, description = excluded.description;

create table if not exists public.ref_split_modes (code text primary key, title text not null);
insert into public.ref_split_modes (code, title) values
  ('even', 'Поровну между выплатами месяца'), ('by_days', 'Пропорционально длине расчётного периода')
on conflict (code) do update set title = excluded.title;

create table if not exists public.ref_period_units (code text primary key, title text not null, days integer);
insert into public.ref_period_units (code, title, days) values
  ('day','День',1), ('week','Неделя',7), ('month','Месяц',null), ('year','Год',null)
on conflict (code) do update set title = excluded.title, days = excluded.days;

create table if not exists public.ref_currencies (
  code   text primary key,
  title  text not null,
  symbol text not null default ''
);

insert into public.ref_currencies (code, title, symbol) values
  ('RUB','Российский рубль','₽'), ('USD','Доллар США','$'), ('EUR','Евро','€')
on conflict (code) do update set title = excluded.title, symbol = excluded.symbol;

create table if not exists public.ref_calendars (code text primary key, title text not null);
insert into public.ref_calendars (code, title) values ('ru','Россия')
on conflict (code) do update set title = excluded.title;

create table if not exists public.ref_calendar_days (
  id            uuid primary key default gen_random_uuid(),
  calendar_code text    not null references public.ref_calendars(code) on delete cascade,
  rule          text    not null default 'fixed' check (rule in ('fixed','date')),
  kind          text    not null default 'holiday' check (kind in ('holiday','workday')),
  day           integer check (day between 1 and 31),
  month         integer check (month between 1 and 12),
  exact_date    date,
  title         text    not null default '',
  unique (calendar_code, rule, kind, day, month, exact_date)
);

insert into public.ref_calendar_days (calendar_code, rule, kind, day, month, title) values
  ('ru','fixed','holiday', 1,1,'Новогодние каникулы'),
  ('ru','fixed','holiday', 2,1,'Новогодние каникулы'),
  ('ru','fixed','holiday', 3,1,'Новогодние каникулы'),
  ('ru','fixed','holiday', 4,1,'Новогодние каникулы'),
  ('ru','fixed','holiday', 5,1,'Новогодние каникулы'),
  ('ru','fixed','holiday', 6,1,'Новогодние каникулы'),
  ('ru','fixed','holiday', 7,1,'Рождество'),
  ('ru','fixed','holiday', 8,1,'Новогодние каникулы'),
  ('ru','fixed','holiday',23,2,'День защитника Отечества'),
  ('ru','fixed','holiday', 8,3,'Международный женский день'),
  ('ru','fixed','holiday', 1,5,'Праздник весны и труда'),
  ('ru','fixed','holiday', 9,5,'День Победы'),
  ('ru','fixed','holiday',12,6,'День России'),
  ('ru','fixed','holiday', 4,11,'День народного единства')
on conflict do nothing;

create table if not exists public.ref_setting_defaults (
  key         text primary key,
  value       jsonb not null,
  scope       text  not null default 'account' check (scope in ('account','user')),
  title       text  not null default '',
  description text  not null default ''
);

insert into public.ref_setting_defaults (key, value, scope, title, description) values
  ('base_currency',            '"RUB"'::jsonb,         'account', 'Базовая валюта', 'В ней считаются доходы, расходы и итоги'),
  ('extra_currencies',         '["USD","EUR"]'::jsonb, 'account', 'Дополнительные валюты', 'Доступны целям и подушкам'),
  ('calendar_code',            '"ru"'::jsonb,          'account', 'Производственный календарь', ''),
  ('rounding',                 '1'::jsonb,             'account', 'Округление сумм', ''),
  ('fact_tolerance_pct',       '5'::jsonb,             'account', 'Допуск факта к плану, %', ''),
  ('planned_spend_window_days','45'::jsonb,            'account', 'Окно плановой траты, дней', 'Трата раньше срока этапа на столько дней считается плановой'),
  ('avg_days_in_month',        '29.3'::jsonb,          'account', 'Коэффициент для отпускных', ''),
  ('percent_shortfall_warn',   'true'::jsonb,          'account', 'Предупреждать о недоборе процента', 'Если процентные категории за месяц собрали меньше плана'),
  ('locale',                   '"ru-RU"'::jsonb,       'user',    'Язык и формат чисел', ''),
  ('start_tab',                '"dashboard"'::jsonb,   'user',    'Вкладка при входе', '')
on conflict (key) do update
  set value = excluded.value, scope = excluded.scope, title = excluded.title, description = excluded.description;

grant select on
  public.ref_allocation_stages, public.ref_goal_kinds, public.ref_expense_modes,
  public.ref_split_modes, public.ref_period_units, public.ref_currencies,
  public.ref_calendars, public.ref_calendar_days, public.ref_setting_defaults
to authenticated;

-- =====================================================================
-- 2. АККАУНТЫ И УЧАСТНИКИ
-- =====================================================================

create table if not exists public.accounts (
  id            uuid primary key default gen_random_uuid(),
  title         text not null default 'Мой план',
  base_currency text not null default 'RUB' references public.ref_currencies(code),
  calendar_code text not null default 'ru'  references public.ref_calendars(code),
  created_by    uuid not null default auth.uid() references auth.users(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.account_members (
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'editor' check (role in ('owner','editor','viewer')),
  added_at   timestamptz not null default now(),
  primary key (account_id, user_id)
);

create index if not exists account_members_user_idx on public.account_members (user_id);

-- Проверки доступа вынесены в security definer: иначе политика на account_members
-- рекурсивно вызывала бы саму себя.
create or replace function public.is_account_member(p_account uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from account_members m where m.account_id = p_account and m.user_id = auth.uid());
$$;

create or replace function public.can_edit_account(p_account uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from account_members m
    where m.account_id = p_account and m.user_id = auth.uid() and m.role in ('owner','editor'));
$$;

alter table public.accounts enable row level security;
drop policy if exists account_read on public.accounts;
create policy account_read on public.accounts for select to authenticated
  using (public.is_account_member(id));
drop policy if exists account_update on public.accounts;
create policy account_update on public.accounts for update to authenticated
  using (public.can_edit_account(id)) with check (public.can_edit_account(id));
drop policy if exists account_insert on public.accounts;
create policy account_insert on public.accounts for insert to authenticated
  with check (created_by = auth.uid());

alter table public.account_members enable row level security;
drop policy if exists members_read on public.account_members;
create policy members_read on public.account_members for select to authenticated
  using (user_id = auth.uid() or public.is_account_member(account_id));
drop policy if exists members_manage on public.account_members;
create policy members_manage on public.account_members for all to authenticated
  using (public.can_edit_account(account_id))
  with check (public.can_edit_account(account_id));

grant select, insert, update, delete on public.accounts, public.account_members to authenticated;
grant execute on function public.is_account_member(uuid), public.can_edit_account(uuid) to authenticated;

-- =====================================================================
-- 3. НАСТРОЙКИ И КУРСЫ ВАЛЮТ
-- Настройки плана — у аккаунта, личные (язык, стартовая вкладка) — у пользователя.
-- =====================================================================

create table if not exists public.account_settings (
  account_id uuid  not null references public.accounts(id) on delete cascade,
  key        text  not null,
  value      jsonb not null,
  primary key (account_id, key)
);

create table if not exists public.user_settings (
  user_id uuid  not null default auth.uid() references auth.users(id) on delete cascade,
  key     text  not null,
  value   jsonb not null,
  primary key (user_id, key)
);

alter table public.user_settings enable row level security;
drop policy if exists owner_all on public.user_settings;
create policy owner_all on public.user_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.user_settings to authenticated;

-- Курсы валют: приложение подтягивает их раз в день и складывает сюда.
create table if not exists public.fx_rates (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  base_code  text    not null references public.ref_currencies(code),
  quote_code text    not null references public.ref_currencies(code),
  rate_date  date    not null,
  rate       numeric not null check (rate > 0),
  source     text    not null default 'manual',
  primary key (account_id, base_code, quote_code, rate_date)
);

create table if not exists public.allocation_rules (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  stage_code text    not null references public.ref_allocation_stages(code) on delete cascade,
  priority   integer not null,
  enabled    boolean not null default true,
  params     jsonb   not null default '{}'::jsonb,
  primary key (account_id, stage_code)
);

-- =====================================================================
-- 4. ДОХОДЫ
-- =====================================================================

create table if not exists public.plan_years (
  account_id    uuid    not null references public.accounts(id) on delete cascade,
  year          integer not null,
  calendar_code text    not null default 'ru' references public.ref_calendars(code),
  note          text    not null default '',
  primary key (account_id, year)
);

-- Слот графика выплат: какого числа платят и за какой отрезок месяца.
-- month_offset: 0 — платят в том же месяце, за который начислено; 1 — в следующем.
-- window_from_day / window_to_day: расчётный период слота, 31 = конец месяца.
create table if not exists public.payout_slots (
  account_id      uuid    not null references public.accounts(id) on delete cascade,
  year            integer not null,
  sort_order      integer not null,
  title           text    not null default '',
  pay_day         integer not null check (pay_day between 1 and 31),
  month_offset    integer not null default 0 check (month_offset between 0 and 2),
  window_from_day integer not null default 1  check (window_from_day between 1 and 31),
  window_to_day   integer not null default 31 check (window_to_day between 1 and 31),
  shift_rule      text    not null default 'back' check (shift_rule in ('back','forward','none')),
  primary key (account_id, year, sort_order),
  foreign key (account_id, year) references public.plan_years(account_id, year) on delete cascade
);

create table if not exists public.salary_rates (
  account_id     uuid    not null references public.accounts(id) on delete cascade,
  id             text    not null,
  effective_from date    not null,
  amount         numeric not null default 0,
  is_gross       boolean not null default true,
  note           text    not null default '',
  primary key (account_id, id)
);

create table if not exists public.tax_scales (
  account_id      uuid    not null references public.accounts(id) on delete cascade,
  id              text    not null,
  title           text    not null default '',
  valid_from_year integer not null default 2000,
  cumulative      boolean not null default true,
  primary key (account_id, id)
);

create table if not exists public.tax_brackets (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  scale_id   text    not null,
  sort_order integer not null,
  up_to      numeric,
  rate       numeric not null default 0,
  primary key (account_id, scale_id, sort_order),
  foreign key (account_id, scale_id) references public.tax_scales(account_id, id) on delete cascade
);

-- Выплата: расчётный период задан датами, а не половиной месяца
create table if not exists public.periods (
  account_id   uuid    not null references public.accounts(id) on delete cascade,
  id           text    not null,
  year         integer not null,
  slot_order   integer,
  title        text    not null default '',
  pay_date     date    not null,
  window_start date    not null,
  window_end   date    not null,
  calc_mode    text    not null default 'auto' check (calc_mode in ('auto','manual')),
  income_net   numeric not null default 0,
  note         text    not null default '',
  locked       boolean not null default false,
  primary key (account_id, id)
);

create index if not exists periods_account_date_idx on public.periods (account_id, pay_date);

create table if not exists public.extra_incomes (
  account_id       uuid    not null references public.accounts(id) on delete cascade,
  id               text    not null,
  date             date,
  amount           numeric not null default 0,
  currency_code    text    not null default 'RUB' references public.ref_currencies(code),
  note             text    not null default '',
  counted_in_total boolean not null default true,
  primary key (account_id, id)
);

create table if not exists public.income_history (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  year       integer not null,
  month      integer not null check (month between 1 and 12),
  amount     numeric not null default 0,
  source     text    not null default 'manual' check (source in ('manual','periods')),
  primary key (account_id, year, month)
);

create table if not exists public.working_day_overrides (
  account_id   uuid    not null references public.accounts(id) on delete cascade,
  ym           text    not null check (ym ~ '^[0-9]{4}-[0-9]{2}$'),
  working_days integer,
  primary key (account_id, ym)
);

create table if not exists public.account_calendar_days (
  account_id uuid not null references public.accounts(id) on delete cascade,
  date       date not null,
  kind       text not null default 'holiday' check (kind in ('holiday','workday')),
  title      text not null default '',
  primary key (account_id, date)
);

create table if not exists public.vacations (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  id         text    not null,
  title      text    not null default '',
  start_date date    not null,
  end_date   date    not null,
  pay_amount numeric not null default 0,
  pay_manual boolean not null default false,
  primary key (account_id, id)
);

create table if not exists public.sick_leaves (
  account_id uuid not null references public.accounts(id) on delete cascade,
  id         text not null,
  start_date date,
  end_date   date,
  note       text not null default '',
  primary key (account_id, id)
);

-- =====================================================================
-- 5. РАСХОДЫ
-- monthly_amount — план категории на месяц. В режиме percent_income он остаётся
-- ориентиром: приложение сравнивает с ним то, что удержано процентом за месяц.
-- =====================================================================

create table if not exists public.expense_categories (
  account_id     uuid    not null references public.accounts(id) on delete cascade,
  id             text    not null,
  title          text    not null default '',
  mode           text    not null default 'fixed_month' references public.ref_expense_modes(code),
  monthly_amount numeric not null default 0,
  percent_value  numeric not null default 0 check (percent_value >= 0 and percent_value <= 100),
  split_mode     text    not null default 'even' references public.ref_split_modes(code),
  season_from    text,
  season_to      text,
  sort_order     integer not null default 0,
  primary key (account_id, id)
);

create table if not exists public.expense_items (
  account_id  uuid    not null references public.accounts(id) on delete cascade,
  id          text    not null,
  category_id text    not null,
  title       text    not null default '',
  amount      numeric not null default 0,
  season_from text,
  season_to   text,
  sort_order  integer not null default 0,
  primary key (account_id, id),
  foreign key (account_id, category_id) references public.expense_categories(account_id, id) on delete cascade
);

create table if not exists public.expense_period_overrides (
  account_id  uuid    not null references public.accounts(id) on delete cascade,
  period_id   text    not null,
  category_id text    not null,
  amount      numeric not null default 0,
  primary key (account_id, period_id, category_id)
);

create table if not exists public.expense_facts (
  account_id     uuid    not null references public.accounts(id) on delete cascade,
  ym             text    not null check (ym ~ '^[0-9]{4}-[0-9]{2}$'),
  category_id    text    not null,
  item_key       text    not null default '',
  amount         numeric not null default 0,
  category_title text    not null default '',
  item_title     text    not null default '',
  entered_by     uuid    references auth.users(id),
  primary key (account_id, ym, category_id, item_key)
);

-- =====================================================================
-- 6. ДОЛГИ
-- =====================================================================

create table if not exists public.credit_cards (
  account_id    uuid    not null references public.accounts(id) on delete cascade,
  id            text    not null,
  title         text    not null default '',
  credit_limit  numeric not null default 0,
  grace_days    integer not null default 60,
  currency_code text    not null default 'RUB' references public.ref_currencies(code),
  sort_order    integer not null default 0,
  primary key (account_id, id)
);

create table if not exists public.credit_card_ops (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  id         text    not null,
  card_id    text    not null,
  op_date    date,
  amount     numeric not null default 0,
  kind       text    not null default 'spend' check (kind in ('spend','payment')),
  title      text    not null default '',
  sort_order integer not null default 0,
  primary key (account_id, id),
  foreign key (account_id, card_id) references public.credit_cards(account_id, id) on delete cascade
);

create table if not exists public.credit_payment_overrides (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  period_id  text    not null,
  card_id    text    not null,
  amount     numeric not null default 0,
  primary key (account_id, period_id, card_id)
);

create table if not exists public.installments (
  account_id  uuid    not null references public.accounts(id) on delete cascade,
  id          text    not null,
  title       text    not null default '',
  total       numeric not null default 0,
  parts       integer not null default 1,
  every_n     integer not null default 2,
  period_unit text    not null default 'week' references public.ref_period_units(code),
  first_date  date,
  sort_order  integer not null default 0,
  primary key (account_id, id)
);

create table if not exists public.installment_payments (
  account_id     uuid    not null references public.accounts(id) on delete cascade,
  id             text    not null,
  installment_id text    not null,
  pay_date       date,
  amount         numeric not null default 0,
  paid           boolean not null default false,
  sort_order     integer not null default 0,
  primary key (account_id, id),
  foreign key (account_id, installment_id) references public.installments(account_id, id) on delete cascade
);

-- =====================================================================
-- 7. НАКОПЛЕНИЯ
-- =====================================================================

create table if not exists public.goals (
  account_id       uuid    not null references public.accounts(id) on delete cascade,
  id               text    not null,
  title            text    not null default '',
  kind_code        text    not null default 'bucket' references public.ref_goal_kinds(code),
  currency_code    text    not null default 'RUB' references public.ref_currencies(code),
  priority         integer not null default 1,
  target_amount    numeric not null default 0,
  deadline         date,
  starting_balance numeric not null default 0,
  pace_amount      numeric not null default 0,
  completed        boolean not null default false,
  primary key (account_id, id)
);

-- Этап цели. Сгенерированные строки помечены source и occurrence_key.
-- user_edited = true снимает строку с автообновления: генератор её не трогает.
create table if not exists public.goal_milestones (
  account_id     uuid    not null references public.accounts(id) on delete cascade,
  id             text    not null,
  goal_id        text    not null,
  title          text    not null default '',
  target         numeric not null default 0,
  deadline       date,
  source         text    not null default 'manual' check (source in ('manual','cycle','gift')),
  source_ref     text,
  occurrence_key text,
  user_edited    boolean not null default false,
  sort_order     integer not null default 0,
  primary key (account_id, id),
  foreign key (account_id, goal_id) references public.goals(account_id, id) on delete cascade
);

create table if not exists public.goal_cycles (
  account_id  uuid    not null references public.accounts(id) on delete cascade,
  id          text    not null,
  goal_id     text    not null,
  title       text    not null default '',
  amount      numeric not null default 0,
  every_n     integer not null default 1,
  period_unit text    not null default 'year' references public.ref_period_units(code),
  start_date  date    not null,
  repeats     integer,
  auto_spend  boolean not null default true,
  enabled     boolean not null default true,
  primary key (account_id, id),
  foreign key (account_id, goal_id) references public.goals(account_id, id) on delete cascade
);

-- Вхождения цикла, удалённые пользователем: генератор их не восстанавливает
create table if not exists public.goal_cycle_skips (
  account_id     uuid not null references public.accounts(id) on delete cascade,
  cycle_id       text not null,
  occurrence_key text not null,
  primary key (account_id, cycle_id, occurrence_key),
  foreign key (account_id, cycle_id) references public.goal_cycles(account_id, id) on delete cascade
);

create table if not exists public.goal_transactions (
  account_id      uuid    not null references public.accounts(id) on delete cascade,
  id              text    not null,
  goal_id         text    not null,
  date            date    not null,
  amount          numeric not null default 0,
  kind            text    not null default 'spend'
                  check (kind in ('spend','deposit','transfer_in','transfer_out')),
  title           text    not null default '',
  counterparty_id text,
  milestone_id    text,
  source          text    not null default 'manual' check (source in ('manual','cycle','gift')),
  occurrence_key  text,
  user_edited     boolean not null default false,
  primary key (account_id, id),
  foreign key (account_id, goal_id) references public.goals(account_id, id) on delete cascade
);

create table if not exists public.savings_period_overrides (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  period_id  text    not null,
  goal_id    text    not null,
  amount     numeric not null default 0,
  primary key (account_id, period_id, goal_id)
);

-- =====================================================================
-- 8. ПОДАРКИ
-- =====================================================================

create table if not exists public.gift_events (
  account_id  uuid    not null references public.accounts(id) on delete cascade,
  id          text    not null,
  goal_id     text,
  title       text    not null default '',
  day         integer not null default 1 check (day between 1 and 31),
  month       integer not null default 1 check (month between 1 and 12),
  repeat_kind text    not null default 'yearly' check (repeat_kind in ('yearly','once')),
  base_year   integer,
  sort_order  integer not null default 0,
  primary key (account_id, id)
);

-- Сумма по годам: новый год получает прошлогоднюю, правка нового года прошлые не трогает
create table if not exists public.gift_event_amounts (
  account_id uuid    not null references public.accounts(id) on delete cascade,
  event_id   text    not null,
  year       integer not null,
  amount     numeric not null default 0,
  primary key (account_id, event_id, year),
  foreign key (account_id, event_id) references public.gift_events(account_id, id) on delete cascade
);

-- =====================================================================
-- 9. ПРАВА: доступ по участию в аккаунте
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'account_settings','fx_rates','allocation_rules','plan_years','payout_slots',
    'salary_rates','tax_scales','tax_brackets','periods','extra_incomes','income_history',
    'working_day_overrides','account_calendar_days','vacations','sick_leaves',
    'expense_categories','expense_items','expense_period_overrides','expense_facts',
    'credit_cards','credit_card_ops','credit_payment_overrides',
    'installments','installment_payments',
    'goals','goal_milestones','goal_cycles','goal_cycle_skips','goal_transactions',
    'savings_period_overrides','gift_events','gift_event_amounts'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('create policy member_read on public.%I for select to authenticated using (public.is_account_member(account_id))', t);
    execute format('drop policy if exists member_write on public.%I', t);
    execute format('create policy member_write on public.%I for all to authenticated using (public.can_edit_account(account_id)) with check (public.can_edit_account(account_id))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- =====================================================================
-- 10. СОЗДАНИЕ АККАУНТА И УЧАСТНИКИ
-- =====================================================================

create or replace function public.create_account(p_title text default 'Мой план',
                                                 p_currency text default 'RUB',
                                                 p_calendar text default 'ru')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'Нужно войти в приложение';
  end if;

  insert into accounts (title, base_currency, calendar_code, created_by)
  values (coalesce(nullif(p_title,''), 'Мой план'), p_currency, p_calendar, v_uid)
  returning id into v_id;

  insert into account_members (account_id, user_id, role) values (v_id, v_uid, 'owner');

  insert into allocation_rules (account_id, stage_code, priority, enabled)
  select v_id, code, default_priority, true from ref_allocation_stages;

  insert into account_settings (account_id, key, value)
  select v_id, key, value from ref_setting_defaults where scope = 'account';

  update account_settings set value = to_jsonb(p_currency)
  where account_id = v_id and key = 'base_currency';

  return v_id;
end;
$$;

-- Добавление участника по почте: пользователь уже должен быть заведён админом
create or replace function public.add_account_member(p_account uuid, p_email text, p_role text default 'editor')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_user uuid;
begin
  if not public.can_edit_account(p_account) then
    raise exception 'Нет прав на этот план';
  end if;
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then
    raise exception 'Пользователь с такой почтой не найден';
  end if;
  insert into account_members (account_id, user_id, role)
  values (p_account, v_user, p_role)
  on conflict (account_id, user_id) do update set role = excluded.role;
end;
$$;

grant execute on function public.create_account(text, text, text) to authenticated;
grant execute on function public.add_account_member(uuid, text, text) to authenticated;


-- SOURCE: v2/sql/002_api.sql
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


-- SOURCE: v2/sql/003_taxable.sql
-- =====================================================================
-- 003_taxable.sql — налог у разовых выплат
--
-- Разовая выплата (calc_mode = 'manual') по умолчанию налогом не облагается:
-- подарок, возврат, перевод от родных. Если выплата всё-таки облагается
-- (премия, подработка по договору), в форме создания ставится галочка, и
-- она пишется в эту колонку.
--
-- Выплаты по графику (calc_mode = 'auto') облагаются всегда — у них налог
-- считается по окладу и шкале, поэтому значение по умолчанию true.
--
-- После выполнения обновите кэш схемы:  notify pgrst, 'reload schema';
-- =====================================================================

alter table public.periods
  add column if not exists taxable boolean not null default true;

comment on column public.periods.taxable is
  'Облагается ли выплата налогом. У разовых выплат приложение ставит false, если пользователь не отметил обратное.';

notify pgrst, 'reload schema';


-- SOURCE: v2/sql/004_kinds_and_indexation.sql
-- =====================================================================
-- 004_kinds_and_indexation.sql
--
-- 1. periods.manual_kind — тип разовой выплаты: премия, подработка, подарок.
--    Премия и подработка облагаются налогом и входят в средний заработок для
--    отпускных; подарок — нет. Тип пишется только у разовых выплат
--    (calc_mode = 'manual'), у выплат по графику остаётся null.
--
-- 2. salary_rates.indexed — повышение оклада с индексацией или без.
--    Индексация (п. 16 Положения № 922) применяется, когда оклады подняли
--    всем работникам: тогда заработок до повышения умножается на
--    новый оклад / старый. Персональное повышение индексации не даёт,
--    поэтому по умолчанию false.
--
-- После выполнения обновите кэш схемы:  notify pgrst, 'reload schema';
-- =====================================================================

alter table public.periods
  add column if not exists manual_kind text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'periods_manual_kind_chk') then
    alter table public.periods
      add constraint periods_manual_kind_chk
      check (manual_kind is null or manual_kind in ('bonus', 'side_job', 'gift'));
  end if;
end $$;

alter table public.salary_rates
  add column if not exists indexed boolean not null default false;

comment on column public.periods.manual_kind is
  'Тип разовой выплаты: bonus — премия, side_job — подработка, gift — подарок. У выплат по графику null.';
comment on column public.salary_rates.indexed is
  'true — повышение оклада коснулось всех: заработок до него индексируется при расчёте отпускных.';

notify pgrst, 'reload schema';


-- SOURCE: v2/sql/005_logger.sql
create table if not exists public.client_logs (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid,
  level      text not null check (level in ('error','warn','info')),
  message    text not null,
  context    jsonb not null default '{}'::jsonb,
  ua         text
);

create index if not exists client_logs_created_idx on public.client_logs (created_at);
create index if not exists client_logs_user_idx    on public.client_logs (user_id, created_at);

alter table public.client_logs enable row level security;
revoke all on public.client_logs from anon, authenticated;   -- напрямую таблица недоступна

create or replace function public.log_client_event(
  p_level text, p_message text, p_context jsonb default '{}', p_ua text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_level not in ('error','warn','info') then return; end if;
  if pg_column_size(coalesce(p_context,'{}'::jsonb)) > 4000 then return; end if;

  -- общий потолок: при спаме база не раздуется
  if (select count(*) from client_logs
       where created_at > now() - interval '1 minute') >= 200 then
    return;
  end if;
  -- лимит на пользователя (для невошедших он общий)
  if (select count(*) from client_logs
       where created_at > now() - interval '1 minute'
         and user_id is not distinct from auth.uid()) >= 30 then
    return;
  end if;

  insert into client_logs (user_id, level, message, context, ua)
  values (auth.uid(), p_level, left(coalesce(p_message,''), 500),
          coalesce(p_context,'{}'::jsonb), left(p_ua, 200));
end;
$$;

revoke execute on function public.log_client_event(text,text,jsonb,text) from public;
grant  execute on function public.log_client_event(text,text,jsonb,text) to anon, authenticated;

notify pgrst, 'reload schema';

-- SOURCE: v2/sql/006_goal_completion.sql
-- Финансы v2: прогресс вручную закрытой цели на дату её закрытия.
-- Для уже установленной v2 выполните этот файл в Supabase SQL Editor.
-- state_get / state_save работают с колонками динамически: менять API не нужно.

alter table public.goals
  add column if not exists completion_snapshot jsonb;

comment on column public.goals.completion_snapshot is
  'Снимок ручного закрытия: дата, прогресс, состояние текущего этапа и даты накопленных этапов. Движения после закрытия меняют баланс, но не прогресс. При возврате в работу снимок очищается.';

notify pgrst, 'reload schema';


-- SOURCE: v2/sql/007_goal_archive.sql
-- Архив и видимость целей в Обзоре независимы от закрытия цели.
-- Выполнить после 006_goal_completion.sql перед обновлением приложения.
alter table public.goals
  add column if not exists archived boolean not null default false,
  add column if not exists hidden_overview boolean not null default false;

alter table public.goals alter column priority drop not null;
update public.goals set priority = null where completed;

comment on column public.goals.archived is 'Убрана в архив Копилок/Подушек; возврат из архива не открывает цель.';
comment on column public.goals.hidden_overview is 'Скрыта пользователем с Обзора; архив сам по себе не скрывает цель.';
comment on column public.goals.priority is 'Очередь активных целей своего типа; у закрытой цели NULL.';

notify pgrst, 'reload schema';


-- SOURCE: v2/sql/008_income_manual.sql
-- Различаем ручной доход и автоматически рассчитанный; NULL — старые записи.
alter table public.periods add column if not exists income_manual boolean;
comment on column public.periods.income_manual is
  'TRUE: сумма закреплена вручную; FALSE: незакреплённая выплата пересчитывается по формуле; NULL: происхождение старой суммы ещё не определено.';

alter table public.installment_payments
  add column if not exists manual_fields text[] not null default '{}';
comment on column public.installment_payments.manual_fields is
  'Поля графика, исправленные вручную: amount и pay_date. При пересборке сохраняются.';

notify pgrst, 'reload schema';


-- SOURCE: v2/sql/009_sick_benefits.sql
-- Расчёт больничных и отдельные поступления. Старые записи остаются только отсутствием,
-- пока пользователь не включит расчёт и не заполнит заработок, стаж и даты платежей.
alter table public.sick_leaves
  add column if not exists benefit_enabled boolean not null default false,
  add column if not exists reason text not null default 'illness',
  add column if not exists insurance_years integer,
  add column if not exists insurance_months integer not null default 0,
  add column if not exists earnings1 numeric,
  add column if not exists earnings2 numeric,
  add column if not exists base_year1 integer,
  add column if not exists base_year2 integer,
  add column if not exists replacement_confirmed boolean not null default false,
  add column if not exists district_coefficient numeric not null default 1,
  add column if not exists employment_fraction numeric not null default 1,
  add column if not exists mrot numeric,
  add column if not exists cap1 numeric,
  add column if not exists cap2 numeric,
  add column if not exists max_base numeric,
  add column if not exists excluded_days integer not null default 0,
  add column if not exists case_start_date date,
  add column if not exists prior_case_days integer not null default 0,
  add column if not exists child_age integer,
  add column if not exists child_category text not null default 'usual',
  add column if not exists recipient text not null default '',
  add column if not exists treatment text not null default 'outpatient',
  add column if not exists used_days integer not null default 0,
  add column if not exists employer_pay_date date,
  add column if not exists sfr_pay_date date,
  add column if not exists employer_net numeric,
  add column if not exists sfr_net numeric,
  add column if not exists employer_gross numeric,
  add column if not exists sfr_gross numeric,
  add column if not exists sfr_prior_tax_base numeric not null default 0;

comment on column public.sick_leaves.earnings1 is 'Начисленный заработок, облагаемый взносами на ВНиМ, за первый расчётный год; NULL — неизвестен, 0 — заработка не было.';
comment on column public.sick_leaves.earnings2 is 'Начисленный заработок, облагаемый взносами на ВНиМ, за второй расчётный год; не база отпускных.';
comment on column public.sick_leaves.max_base is 'Сумма предельных баз двух календарных лет перед страховым случаем, для максимального дневного заработка; не заменяется при замене расчётных лет.';
comment on column public.sick_leaves.used_days is 'Оплаченные дни ухода за тем же получателем в этом году вне плана. Листы плана учитываются дополнительно автоматически.';

alter table public.periods
  add column if not exists sick_leave_id text,
  add column if not exists sick_payer text,
  add column if not exists sick_gross numeric;

-- Родитель должен сохраняться раньше выплат; при удалении порядок обратный.
update public.api_domain_tables set load_order = 55 where table_name = 'sick_leaves';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'periods_sick_leave_fk' and conrelid = 'public.periods'::regclass) then
    alter table public.periods add constraint periods_sick_leave_fk
      foreign key (account_id, sick_leave_id) references public.sick_leaves(account_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'periods_sick_payer_chk' and conrelid = 'public.periods'::regclass) then
    alter table public.periods add constraint periods_sick_payer_chk check (
      (sick_leave_id is null and sick_payer is null and sick_gross is null)
      or (sick_leave_id is not null and sick_payer in ('employer','sfr') and sick_payer is not null and sick_gross >= 0 and sick_gross is not null)
    );
  end if;
end $$;
create index if not exists periods_sick_leave_idx on public.periods(account_id, sick_leave_id) where sick_leave_id is not null;

-- У прежней схемы правки выплат не имеют FK на periods. Убираем их только
-- при удалении связанной с больничным выплаты, в том же плане и транзакции.
create or replace function api_private.delete_sick_period_links()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if old.sick_leave_id is not null then
    delete from public.expense_period_overrides where account_id = old.account_id and period_id = old.id;
    delete from public.savings_period_overrides where account_id = old.account_id and period_id = old.id;
    delete from public.credit_payment_overrides where account_id = old.account_id and period_id = old.id;
  end if;
  return old;
end $$;
revoke all on function api_private.delete_sick_period_links() from public, anon, authenticated;
drop trigger if exists delete_sick_period_links on public.periods;
create trigger delete_sick_period_links after delete on public.periods
for each row execute function api_private.delete_sick_period_links();

-- Действующие account_id/RLS и проверка роли в state_save остаются в силе.
notify pgrst, 'reload schema';


-- SOURCE: v2/sql/010_sick_period_split.sql
-- Больничный распределяется по выплатам оклада. Снимок закреплённой выплаты
-- сохраняет её части больничного независимо от последующих правок/удаления листа.
alter table public.periods add column if not exists sick_snapshot jsonb;
comment on column public.periods.sick_snapshot is
  'Части больничного в зафиксированной выплате: плательщик, дни, начисление, НДФЛ, сумма на руки. NULL — ещё не фиксировались; [] — больничного не было.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'periods_sick_snapshot_chk' and conrelid = 'public.periods'::regclass) then
    alter table public.periods add constraint periods_sick_snapshot_chk
      check (sick_snapshot is null or jsonb_typeof(sick_snapshot) = 'array');
  end if;
end $$;
notify pgrst, 'reload schema';


-- SOURCE: supabase/migrations/20261031172114_family_plan.sql
-- Семейный бюджет: отдельные данные, закрытый журнал источников, атомарное API.
-- Выполнять после v2/sql/001_schema.sql ... 010_sick_period_split.sql.

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


-- SOURCE: supabase/migrations/20261031204207_voluntary_account_deletion.sql
-- Добровольное удаление собственного пользователя. Выполнять после family_plan.
-- Учётная запись Auth и связанные личные данные удаляются одной транзакцией.

create schema if not exists account_api;
revoke all on schema account_api from public,anon;
grant usage on schema account_api to authenticated;

-- Автор может уйти, не удаляя общий план и введённые им общие расходы.
alter table public.accounts alter column created_by drop not null;
alter table public.accounts drop constraint if exists accounts_created_by_fkey;
alter table public.accounts add constraint accounts_created_by_fkey foreign key(created_by) references auth.users(id) on delete set null;
alter table public.expense_facts drop constraint if exists expense_facts_entered_by_fkey;
alter table public.expense_facts add constraint expense_facts_entered_by_fkey foreign key(entered_by) references auth.users(id) on delete set null;
alter table public.family_contributions alter column source_account_id drop not null;
alter table public.family_contributions drop constraint if exists family_contributions_source_account_id_fkey;
alter table public.family_contributions add constraint family_contributions_source_account_id_fkey foreign key(source_account_id) references public.accounts(id) on delete set null;
alter table public.family_invitations alter column created_by drop not null;

create or replace function account_api.require_user()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); begin
  if uid is null or not exists(select 1 from auth.users where id=uid) then
    raise sqlstate 'PT401' using message='Нужно войти в действующий аккаунт';
  end if;
  return uid;
end $$;

create or replace function account_api.deletion_preview()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=account_api.require_user(); plans jsonb; family jsonb; result jsonb; begin
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,
    'delete',not exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id<>uid),
    'blocked',exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid and m.role='owner')
      and exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id<>uid)
      and not exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id<>uid and m.role='owner'),
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'role',m.role) order by m.user_id),'[]')
      from public.account_members m where m.account_id=a.id),
    'recipients',case when exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid and m.role='owner')
      then (select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'email',u.email) order by m.user_id),'[]')
        from public.account_members m join auth.users u on u.id=m.user_id where m.account_id=a.id and m.user_id<>uid)
      else '[]'::jsonb end) order by a.id),'[]') into plans
  from public.accounts a where a.plan_kind='personal' and (exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid)
    or a.created_by=uid and not exists(select 1 from public.account_members m where m.account_id=a.id));
  select jsonb_build_object('id',f.id,'title',a.title,
    'last_member',not exists(select 1 from public.family_members x where x.family_id=f.id and x.active and x.user_id is distinct from uid),
    'members',(select jsonb_agg(x.id order by x.id) from public.family_members x where x.family_id=f.id and x.active)) into family
    from public.family_members m join public.families f on f.id=m.family_id join public.accounts a on a.id=f.id
    where m.user_id=uid and m.active;
  result:=jsonb_build_object('plans',(select coalesce(jsonb_agg(x-'members'),'[]') from jsonb_array_elements(plans) x),
    'family',family-'members','version',md5(jsonb_build_object('plans',plans,'family',family)::text));
  return result;
end $$;

-- Владелец явно выбирает уже существующего участника обычного общего плана.
create or replace function account_api.assign_owner(p_account uuid,p_user uuid)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=account_api.require_user(); begin
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform 1 from public.accounts where id=p_account and plan_kind='personal' for update;
  if not found or not exists(select 1 from public.account_members where account_id=p_account and user_id=uid and role='owner') then
    raise sqlstate 'PT403' using message='Назначить владельца может только владелец личного плана';
  end if;
  if p_user=uid or not exists(select 1 from public.account_members where account_id=p_account and user_id=p_user) then
    raise sqlstate 'PT400' using message='Выберите другого существующего участника плана';
  end if;
  update public.account_members set role='owner' where account_id=p_account and user_id=p_user;
end $$;

create or replace function account_api.redact_actor(value jsonb,uid uuid,email text,member_ids uuid[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare key text; begin
  if value is null then return null; end if;
  foreach key in array array['user_id','created_by','accepted_by','actor_id'] loop
    if value->>key=uid::text then value:=jsonb_set(value,array[key],'null'::jsonb); end if;
  end loop;
  if lower(value->>'email')=lower(email) or value->>'id'=any(member_ids::text[]) then
    value:=value-'email'||jsonb_build_object('nickname','Удалённый участник');
  end if;
  return value;
end $$;

create or replace function account_api.delete_self(p_confirmation text,p_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=account_api.require_user(); preview jsonb; v_email text; member_ids uuid[]; plan_ids uuid[]; f uuid; begin
  if upper(btrim(coalesce(p_confirmation,'')))<>'УДАЛИТЬ' then
    raise sqlstate 'PT400' using message='Для подтверждения введите УДАЛИТЬ';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform 1 from auth.users where id=uid for update;
  perform 1 from public.families where id in(select family_id from public.family_members where user_id=uid) order by id for update;
  perform 1 from public.accounts a where a.created_by=uid or exists(select 1 from public.account_members m where m.account_id=a.id and m.user_id=uid) order by a.id for update;
  perform 1 from public.account_members m where m.account_id in(select account_id from public.account_members where user_id=uid) order by m.account_id,m.user_id for update;
  preview:=account_api.deletion_preview();
  if p_version is distinct from preview->>'version' then raise sqlstate 'PT409' using message='Состав планов изменился. Проверьте условия удаления ещё раз'; end if;
  if exists(select 1 from jsonb_array_elements(preview->'plans') x where (x->>'blocked')::boolean) then
    raise sqlstate 'PT409' using message='Сначала назначьте другого владельца общих планов';
  end if;
  select u.email into v_email from auth.users u where id=uid;
  select coalesce(array_agg(m.id),'{}') into member_ids from public.family_members m where user_id=uid;
  select coalesce(array_agg((x->>'id')::uuid),'{}') into plan_ids from jsonb_array_elements(preview->'plans') x where (x->>'delete')::boolean;

  -- Прогноз прекращается; сумма и месяцы проведённых взносов остаются семье.
  delete from public.family_contributions where status='forecast' and (member_id=any(member_ids) or source_account_id=any(plan_ids));
  delete from public.family_contribution_rules where member_id=any(member_ids);
  delete from public.family_contribution_overrides where member_id=any(member_ids);
  update public.family_members set active=false,left_at=coalesce(left_at,now()),revision=revision+1,
    user_id=null,email='',nickname='Удалённый участник',color='blue',source_account_id=null where id=any(member_ids);
  update public.family_contributions set available_before=0,ledger_after='{}' where member_id=any(member_ids);
  update public.family_members set source_account_id=null,revision=revision+1 where source_account_id=any(plan_ids);
  update public.family_contributions set source_account_id=null,available_before=0,ledger_after='{}' where source_account_id=any(plan_ids);
  for f in select distinct m.family_id from public.family_members m where m.id=any(member_ids) loop
    if not exists(select 1 from public.family_members where family_id=f and active) then
      update public.families set deleted_at=coalesce(deleted_at,now()),version=version+1 where id=f;
      update public.family_invitations set status='revoked' where family_id=f and status='pending';
      delete from family_api.mail_outbox where invitation_id in(select id from public.family_invitations where family_id=f);
    else update public.families set version=version+1 where id=f;
    end if;
  end loop;

  delete from family_api.mail_outbox where invitation_id in(select id from public.family_invitations where lower(public.family_invitations.email)=lower(v_email) or accepted_by=uid);
  delete from public.family_invitations where lower(public.family_invitations.email)=lower(v_email) or accepted_by=uid;
  update public.family_invitations set created_by=null where created_by=uid;
  update public.family_audit set actor_id=case when actor_id=uid then null else actor_id end,
    actor_name=case when actor_id=uid then 'Удалённый участник' else actor_name end,
    before_data=account_api.redact_actor(before_data,uid,v_email,member_ids),
    after_data=account_api.redact_actor(after_data,uid,v_email,member_ids)
    where actor_id=uid or object_type='family_members' and object_id=any(member_ids::text[])
      or lower(before_data->>'email')=lower(v_email) or lower(after_data->>'email')=lower(v_email)
      or before_data->>'created_by'=uid::text or after_data->>'created_by'=uid::text
      or before_data->>'accepted_by'=uid::text or after_data->>'accepted_by'=uid::text;
  delete from family_api.requests where user_id=uid;
  update family_api.requests set payload=jsonb_set(payload,'{data,email}','null'::jsonb)
    where lower(payload#>>'{data,email}')=lower(v_email);
  delete from public.client_logs where user_id=uid;
  delete from public.account_members where user_id=uid;
  delete from public.accounts where id=any(plan_ids);
  -- auth.users FK удаляет сессии, refresh-токены и собственные настройки.
  -- Старый JWT не получает доступ: участия удалены, новый вход проверяет Auth.
  delete from auth.users where id=uid;
  return jsonb_build_object('deleted',true);
end $$;

create or replace function public.account_deletion_preview()
returns jsonb language sql set search_path='' as $$select account_api.deletion_preview();$$;
create or replace function public.account_assign_owner(p_account uuid,p_user uuid)
returns void language sql set search_path='' as $$select account_api.assign_owner(p_account,p_user);$$;
create or replace function public.delete_my_account(p_confirmation text,p_version text)
returns jsonb language sql set search_path='' as $$select account_api.delete_self(p_confirmation,p_version);$$;
revoke all on all functions in schema account_api from public,anon,authenticated;
grant execute on function account_api.deletion_preview(),account_api.assign_owner(uuid,uuid),account_api.delete_self(text,text) to authenticated;
revoke all on function public.account_deletion_preview(),public.account_assign_owner(uuid,uuid),public.delete_my_account(text,text) from public,anon;
grant execute on function public.account_deletion_preview(),public.account_assign_owner(uuid,uuid),public.delete_my_account(text,text) to authenticated;
notify pgrst,'reload schema';


-- SOURCE: supabase/migrations/20261031234538_expense_seasons_and_installment_prepayments.sql

alter table public.expense_categories add column if not exists amount_seasons jsonb not null default '[]';
alter table public.expense_items add column if not exists amount_seasons jsonb not null default '[]';
alter table public.periods add column if not exists installment_snapshot jsonb;

create or replace function api_private.valid_amount_seasons(seasons jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s jsonb; first_day integer; last_day integer; d integer;
  used boolean[] := array_fill(false,array[366]); first_date date; last_date date;
begin
  if jsonb_typeof(seasons) is distinct from 'array' or jsonb_array_length(seasons) > 366 then return false; end if;
  for s in select value from jsonb_array_elements(seasons) loop
    if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'amount') is distinct from 'number'
      or (s->>'amount')::numeric < 0 or coalesce(s->>'from','') !~ '^\d{2}-\d{2}$' or coalesce(s->>'to','') !~ '^\d{2}-\d{2}$' then return false; end if;
    first_date := make_date(2000,split_part(s->>'from','-',1)::int,split_part(s->>'from','-',2)::int);
    last_date := make_date(2000,split_part(s->>'to','-',1)::int,split_part(s->>'to','-',2)::int);
    first_day := first_date - date '2000-01-01' + 1; last_day := last_date - date '2000-01-01' + 1;
    d := first_day;
    loop
      if used[d] then return false; end if;
      used[d] := true;
      exit when d = last_day;
      d := d % 366 + 1;
    end loop;
  end loop;
  return true;
exception when others then return false;
end $$;

create or replace function api_private.valid_installment_snapshot(snapshot jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s jsonb; seen text[] := '{}';
begin
  if snapshot is null then return true; end if;
  if jsonb_typeof(snapshot) is distinct from 'array' then return false; end if;
  for s in select value from jsonb_array_elements(snapshot) loop
    if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'payment_id') is distinct from 'string'
      or jsonb_typeof(s->'installment_id') is distinct from 'string' or jsonb_typeof(s->'date') is distinct from 'string'
      or jsonb_typeof(s->'early') is distinct from 'boolean' or jsonb_typeof(s->'amount') is distinct from 'number'
      or (s->>'amount')::numeric < 0 or s->>'payment_id' = any(seen) then return false; end if;
    if s->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
    perform (s->>'date')::date;
    seen := array_append(seen,s->>'payment_id');
  end loop;
  return true;
exception when others then return false;
end $$;

revoke all on function api_private.valid_amount_seasons(jsonb), api_private.valid_installment_snapshot(jsonb) from public;
grant execute on function api_private.valid_amount_seasons(jsonb), api_private.valid_installment_snapshot(jsonb) to authenticated,service_role;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='expense_categories_amount_seasons_check' and conrelid='public.expense_categories'::regclass) then
    alter table public.expense_categories add constraint expense_categories_amount_seasons_check check(api_private.valid_amount_seasons(amount_seasons));
  end if;
  if not exists(select 1 from pg_constraint where conname='expense_items_amount_seasons_check' and conrelid='public.expense_items'::regclass) then
    alter table public.expense_items add constraint expense_items_amount_seasons_check check(api_private.valid_amount_seasons(amount_seasons));
  end if;
  if not exists(select 1 from pg_constraint where conname='periods_installment_snapshot_check' and conrelid='public.periods'::regclass) then
    alter table public.periods add constraint periods_installment_snapshot_check check(api_private.valid_installment_snapshot(installment_snapshot));
  end if;
end $$;

-- Закрепляем старые платежи рассрочек до включения досрочного погашения.
-- Как в движке: последняя выплата не позже даты части, при совпадении дат — по id.
-- ALTER TABLE удерживает блокировку до COMMIT: другие записи ждут. Защита
-- семейных выплат отключается только внутри этой транзакции для backfill;
-- при любой ошибке её состояние откатится вместе с данными.
alter table public.periods disable trigger protect_family_period;
update public.periods p set installment_snapshot = coalesce((
  select jsonb_agg(jsonb_build_object('payment_id',ip.id,'installment_id',ip.installment_id,
    'date',ip.pay_date,'amount',ip.amount,'early',false) order by ip.pay_date,ip.id)
  from public.installment_payments ip
  where ip.account_id=p.account_id and ip.pay_date is not null and ip.amount>0
    and (select q.id from public.periods q where q.account_id=p.account_id and q.pay_date<=ip.pay_date order by q.pay_date desc,q.id desc limit 1)=p.id
    and not exists(select 1 from public.allocation_rules ar where ar.account_id=p.account_id and ar.stage_code='installments' and not ar.enabled)
), '[]'::jsonb) where p.locked and p.installment_snapshot is null;
alter table public.periods enable trigger protect_family_period;

comment on column public.expense_items.amount_seasons is 'Ежегодные непересекающиеся интервалы from/to (ММ-ДД), amount. Вне интервалов действует amount статьи; season_from/to по-прежнему ограничивают её применимость.';
comment on column public.expense_categories.amount_seasons is 'Сезонные суммы категории без статей. При наличии статей сумма складывается из них.';
comment on column public.periods.installment_snapshot is 'Проведённые части рассрочек: payment_id, installment_id, date, amount, early. NULL — снимка нет, [] — платежей не было.';
notify pgrst, 'reload schema';


-- SOURCE: supabase/migrations/20261101124514_expense_item_percentages.sql

-- Денежная сумма и процент независимы: смена режима категории не стирает их.
alter table public.expense_items
  add column if not exists percent_value numeric not null default 0
    constraint expense_items_percent_value_check check (percent_value >= 0 and percent_value <= 100);

comment on column public.expense_items.percent_value is
  'Процент от полной выплаты для подкатегории в режиме percent_income; процент категории складывается из активных подкатегорий.';

notify pgrst, 'reload schema';


-- SOURCE: supabase/migrations/20261101130135_family_monthly_budget.sql

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


-- SOURCE: supabase/migrations/20261101190301_family_history_and_access.sql

create index if not exists family_audit_created_at_idx on public.family_audit(created_at);
create or replace function family_api.audit_cutoff()
returns timestamptz language sql stable security invoker set search_path='' as $$
  select ((now() at time zone 'Europe/Moscow') - interval '1 month') at time zone 'Europe/Moscow';
$$;

create or replace function family_api.prune_audit(p_family uuid default null)
returns bigint language plpgsql security invoker set search_path='' as $$
declare removed bigint; begin
  delete from public.family_audit where created_at<family_api.audit_cutoff() and (p_family is null or family_id=p_family);
  get diagnostics removed=row_count;
  return removed;
end $$;

-- Page anchor prevents incoming audit events from shifting existing pages.
create or replace function family_api.history_data(p_family uuid,p_page integer default 1,p_anchor bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  with bounds as (select family_api.audit_cutoff() cutoff,coalesce(p_anchor,
    (select max(id) from public.family_audit where family_id=p_family and created_at>=family_api.audit_cutoff()),0) anchor),
  stats as (select count(*)::integer total from public.family_audit a cross join bounds b
    where a.family_id=p_family and a.created_at>=b.cutoff and a.id<=b.anchor),
  page as (select total,greatest(1,(total+9)/10) pages,least(greatest(1,coalesce(p_page,1)),greatest(1,(total+9)/10)) page from stats)
  select jsonb_build_object('items',coalesce((select jsonb_agg(x order by x.id desc) from (
      select a.* from public.family_audit a cross join bounds b where a.family_id=p_family and a.created_at>=b.cutoff and a.id<=b.anchor
      order by a.id desc limit 10 offset (select (page-1)*10 from page)) x),'[]'),
    'page',p.page,'pages',p.pages,'total',p.total,'anchor',b.anchor)
  from page p cross join bounds b;
$$;

create or replace function family_api.history_page(p_family uuid,p_page integer default 1,p_anchor bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform family_api.require_member(p_family);
  perform family_api.prune_audit(p_family);
  return family_api.history_data(p_family,p_page,p_anchor);
end $$;
create or replace function public.family_history_page(p_family uuid,p_page integer default 1,p_anchor bigint default null)
returns jsonb language sql set search_path='' as $$ select family_api.history_page(p_family,p_page,p_anchor); $$;

-- Keep the old cursor endpoint compatible, with the same retention and size.
create or replace function family_api.history(p_family uuid,p_before bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform family_api.require_member(p_family);
  return (select coalesce(jsonb_agg(x order by x.id desc),'[]') from (
    select a.* from public.family_audit a where a.family_id=p_family and a.created_at>=family_api.audit_cutoff()
      and (p_before is null or a.id<p_before) order by a.id desc limit 10) x);
end $$;

do $migration$
declare definition text; begin
  definition:=replace(pg_get_functiondef('family_api.read(uuid)'::regprocedure),E'\r\n',E'\n');
  if position('family-history-access-v3' in definition)=0 then
    definition:=replace(definition,$old$c.family_id = f.id and (c.amount > 0 or c.member_id=m.id and c.status='forecast')$old$,'c.family_id = f.id');
    -- Match a single line: SQL Editor may paste CRLF while the stored
    -- function definition above has already been normalized to LF.
    definition:=replace(definition,$old$'audit', (select coalesce(jsonb_agg(x order by x.id desc),'[]') from (select au.* from public.family_audit au where au.family_id = f.id order by au.id desc limit 200) x),$old$,
      $new$'audit', '[]'::jsonb,$new$);
    definition:=replace(definition,'  return result || jsonb_build_object(', $code$
  -- family-history-access-v3
  result:=result || (select jsonb_build_object('audit',h->'items','audit_page',h->'page','audit_pages',h->'pages','audit_total',h->'total','audit_anchor',h->'anchor')
    from (select family_api.history_data(p_family,1,null) h) history);
  return result || jsonb_build_object($code$);
    if position('family-history-access-v3' in definition)=0 or position('limit 200' in definition)>0 then raise exception 'Не удалось обновить семейную историю'; end if;
    execute definition;
  end if;
  definition:=replace(pg_get_functiondef('family_api.command(text,uuid,jsonb,bigint,uuid)'::regprocedure),E'\r\n',E'\n');
  if position('family-history-access-v3' in definition)=0 then
    definition:=replace(definition,$old$    if p_action in ('category','delete_category','expense','allocation','reset_allocations') then$old$,$code$
    -- family-history-access-v3
    perform family_api.prune_audit(p_family);
    if p_action in ('category','delete_category','expense','allocation','reset_allocations') then$code$);
    definition:=replace(definition,$old$        if contribution.status='posted'$old$,$code$
        if contribution.member_id<>m.id then
          raise sqlstate 'PT403' using message='Можно изменять только распределение своих взносов';
        end if;
        if contribution.status='posted'$code$);
    if position('contribution.member_id<>m.id' in definition)=0 then raise exception 'Не удалось ограничить редактирование распределения'; end if;
    execute definition;
  end if;
  definition:=replace(pg_get_functiondef('family_api.mail_claim(uuid)'::regprocedure),E'\r\n',E'\n');
  if position('family_api.prune_audit' in definition)=0 then
    definition:=replace(definition,'  for r in select',$code$  perform family_api.prune_audit();
  for r in select$code$);
    if position('family_api.prune_audit' in definition)=0 then raise exception 'Не удалось включить очистку истории в серверную задачу'; end if;
    execute definition;
  end if;
end $migration$;

revoke all on function family_api.audit_cutoff(),family_api.prune_audit(uuid),family_api.history_data(uuid,integer,bigint) from public,anon,authenticated,service_role;
revoke all on function public.family_history_page(uuid,integer,bigint) from public,anon,service_role;
revoke all on function family_api.history_page(uuid,integer,bigint) from public,anon,service_role;
grant execute on function family_api.history_page(uuid,integer,bigint) to authenticated;
grant execute on function public.family_history_page(uuid,integer,bigint) to authenticated;
select family_api.prune_audit();

-- Supabase Cron is already used for family payments. Idle families are
-- cleaned as well; without Cron, reads and worker activity enforce retention.
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('family-audit-retention','17 * * * *','select family_api.prune_audit();');
  end if;
end $$;
notify pgrst,'reload schema';

notify pgrst, 'reload schema';
commit;
