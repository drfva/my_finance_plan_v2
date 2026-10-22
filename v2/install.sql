-- =====================================================================
-- Финансы v2: установка в чистый проект Supabase одним запуском.
--
-- Откройте SQL Editor ТЕСТОВОГО проекта, вставьте этот файл целиком и Run.
-- Требуется стандартный Supabase: auth.users, auth.uid(), роли anon и authenticated.
-- Создаёт таблицы, справочники, политики доступа, серверные функции и журнал.
-- Пользователей для входа создайте отдельно в Authentication -> Users.
-- Финансовый план создаётся при первом входе через bootstrap_user.
--
-- Собран из v2/sql/001_schema.sql ... 007_goal_archive.sql в указанном ниже порядке.
-- Исходные SQL включены без изменения. При их изменении пересоберите этот файл.
-- Старые sql/001_base.sql ... 006_schedule.sql и 000_reset_public.sql НЕ включены.
-- Это установочный файл, а не скрипт переноса старой базы на v2.
--
-- Вся установка — одна транзакция: ошибка отменяет её целиком.
-- =====================================================================

begin;

-- =====================================================================
-- SOURCE: v2/sql/001_schema.sql
-- =====================================================================

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


-- =====================================================================
-- SOURCE: v2/sql/002_api.sql
-- =====================================================================

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


-- =====================================================================
-- SOURCE: v2/sql/003_taxable.sql
-- =====================================================================

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


-- =====================================================================
-- SOURCE: v2/sql/004_kinds_and_indexation.sql
-- =====================================================================

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


-- =====================================================================
-- SOURCE: v2/sql/005_logger.sql
-- =====================================================================

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

-- =====================================================================
-- SOURCE: v2/sql/006_goal_completion.sql
-- =====================================================================

-- Финансы v2: прогресс вручную закрытой цели на дату её закрытия.
-- Для уже установленной v2 выполните этот файл в Supabase SQL Editor.
-- state_get / state_save работают с колонками динамически: менять API не нужно.

alter table public.goals
  add column if not exists completion_snapshot jsonb;

comment on column public.goals.completion_snapshot is
  'Снимок ручного закрытия: дата, прогресс, состояние текущего этапа и даты накопленных этапов. Движения после закрытия меняют баланс, но не прогресс. При возврате в работу снимок очищается.';

notify pgrst, 'reload schema';


-- =====================================================================
-- SOURCE: v2/sql/007_goal_archive.sql
-- =====================================================================

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


-- Все изменения и уведомления PostgREST применяются при фиксации транзакции.
notify pgrst, 'reload schema';
commit;

select
  'Финансы v2: установка завершена' as status,
  (select count(*) from public.ref_allocation_stages) as allocation_stages,
  (select count(*) from public.ref_currencies) as currencies,
  (select count(*) from public.ref_setting_defaults) as setting_defaults;
