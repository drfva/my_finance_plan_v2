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
