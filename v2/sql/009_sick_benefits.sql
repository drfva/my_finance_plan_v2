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
