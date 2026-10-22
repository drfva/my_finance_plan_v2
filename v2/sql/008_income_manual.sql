-- Различаем ручной доход и автоматически рассчитанный; NULL — старые записи.
alter table public.periods add column if not exists income_manual boolean;
comment on column public.periods.income_manual is
  'TRUE: сумма закреплена вручную; FALSE: незакреплённая выплата пересчитывается по формуле; NULL: происхождение старой суммы ещё не определено.';

alter table public.installment_payments
  add column if not exists manual_fields text[] not null default '{}';
comment on column public.installment_payments.manual_fields is
  'Поля графика, исправленные вручную: amount и pay_date. При пересборке сохраняются.';

notify pgrst, 'reload schema';
