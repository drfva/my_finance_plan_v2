-- Локальный PostgreSQL после 000_supabase_stub.sql и v2/install.sql.
-- Любая ошибка проверки прерывает выполнение; данные теста откатываются.
begin;
insert into auth.users values
  ('dddddddd-0000-0000-0000-000000000009','sick-owner@test.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000009','sick-other@test.invalid') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000009';
select bootstrap_user();
select state_save('income', '{
  "sick_leaves":[
    {"id":"old","start_date":"2026-01-01","end_date":"2026-01-02"},
    {"id":"s","start_date":"2026-11-01","end_date":"2026-11-10","benefit_enabled":true,
     "reason":"illness","insurance_years":8,"earnings1":730000,"earnings2":730000,
     "employer_pay_date":"2026-11-15","sfr_pay_date":"2026-11-18","sfr_net":12000}
  ],
  "periods":[{"id":"sick:s:employer","year":2026,"pay_date":"2026-11-15",
     "window_start":"2026-11-15","window_end":"2026-11-15","calc_mode":"manual",
     "income_net":5220,"income_manual":false,"sick_leave_id":"s","sick_payer":"employer","sick_gross":6000}]
}');
do $$ declare s jsonb; p jsonb; begin
  select x into s from jsonb_array_elements(state_get()#>'{income,sick_leaves}') x where x->>'id' = 's';
  if s is null or (s->>'earnings1')::numeric <> 730000 or (s->>'sfr_net')::numeric <> 12000 or not (s->>'benefit_enabled')::boolean then
    raise exception 'sick values did not round trip through RPC';
  end if;
  if exists (select 1 from jsonb_array_elements(state_get()#>'{income,sick_leaves}') x where x->>'id' = 'old' and (x->>'benefit_enabled')::boolean) then
    raise exception 'legacy sick leave unexpectedly enabled';
  end if;
  p := state_get()#>'{income,periods,0}';
  if p is null or p->>'sick_leave_id' <> 's' or (p->>'sick_gross')::numeric <> 6000 then raise exception 'sick payment did not round trip'; end if;
end $$;
select state_save('savings', '{"goals":[{"id":"g","title":"Test","kind_code":"bucket"}],"savings_period_overrides":[{"period_id":"sick:s:employer","goal_id":"g","amount":100}]}');

-- Новый владелец не может сослаться на больничный другого плана даже с тем же id.
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000009';
select bootstrap_user();
do $$ begin
  begin
    perform state_save('income', '{"periods":[{"id":"intruder","year":2026,"pay_date":"2026-11-15","window_start":"2026-11-15","window_end":"2026-11-15","sick_leave_id":"s","sick_payer":"sfr","sick_gross":1}]}');
    raise exception 'cross-account sick reference was accepted';
  exception when foreign_key_violation then null; end;
end $$;

set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000009';
-- Каскад удаляет выплату и её отчисления, даже когда патч содержит только родителя.
select state_save('income', '{"sick_leaves":[]}');
do $$ begin
  if jsonb_array_length(state_get()#>'{income,periods}') <> 0 then raise exception 'sick payment cascade failed'; end if;
  if jsonb_array_length(state_get()#>'{savings,savings_period_overrides}') <> 0 then raise exception 'allocation cascade failed'; end if;
end $$;
rollback;
