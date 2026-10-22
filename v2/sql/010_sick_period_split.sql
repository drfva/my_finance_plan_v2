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
