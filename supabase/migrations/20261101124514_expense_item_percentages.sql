begin;

-- Денежная сумма и процент независимы: смена режима категории не стирает их.
alter table public.expense_items
  add column if not exists percent_value numeric not null default 0
    constraint expense_items_percent_value_check check (percent_value >= 0 and percent_value <= 100);

comment on column public.expense_items.percent_value is
  'Процент от полной выплаты для подкатегории в режиме percent_income; процент категории складывается из активных подкатегорий.';

notify pgrst, 'reload schema';
commit;
