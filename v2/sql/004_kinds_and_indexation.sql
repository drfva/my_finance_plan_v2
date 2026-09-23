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
