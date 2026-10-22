-- Локальная база после заглушки Supabase и v2/install.sql.
begin;
insert into auth.users values ('ffffffff-0000-0000-0000-000000000010','sick-split@test.invalid') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = 'ffffffff-0000-0000-0000-000000000010';
select bootstrap_user();
select state_save('income', '{
  "sick_leaves":[{"id":"s","start_date":"2026-11-01","end_date":"2026-11-10"}],
  "periods":[{"id":"salary","year":2026,"pay_date":"2026-11-20","window_start":"2026-11-01","window_end":"2026-11-15",
    "income_net":10000,"income_manual":false,"locked":true,
    "sick_snapshot":[{"leave_id":"s","payer":"employer","days":3,"gross":6000,"net":5220,"tax":780,"taxParts":[{"rate":13,"amount":780}]}]}]
}');
do $$ declare p jsonb; begin
  p := state_get()#>'{income,periods,0}';
  if p is null or jsonb_array_length(p->'sick_snapshot') <> 1 or (p#>>'{sick_snapshot,0,net}')::numeric <> 5220 then
    raise exception 'sick snapshot did not round trip through RPC';
  end if;
  if p->>'sick_leave_id' is not null then raise exception 'salary unexpectedly linked as standalone sick payout'; end if;
  begin
    perform state_save('income', '{"periods":[{"id":"bad","year":2026,"pay_date":"2026-11-20","window_start":"2026-11-01","window_end":"2026-11-15","sick_snapshot":{}}]}');
    raise exception 'invalid snapshot object was accepted';
  exception when check_violation then null; end;
end $$;
select state_save('income', '{"sick_leaves":[]}');
do $$ declare p jsonb; begin
  p := state_get()#>'{income,periods,0}';
  if p is null or p->>'id' <> 'salary' or (p#>>'{sick_snapshot,0,gross}')::numeric <> 6000 then
    raise exception 'deleting sick source changed frozen salary history';
  end if;
end $$;
rollback;
