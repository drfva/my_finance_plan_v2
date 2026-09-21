-- Тест 002_api.sql на локальном Postgres с заглушкой Supabase.
\set ON_ERROR_STOP 0
\pset format unaligned
\pset tuples_only on
insert into auth.users values
  ('aaaaaaaa-0000-0000-0000-000000000001','a@x.ru'),
  ('bbbbbbbb-0000-0000-0000-000000000002','b@x.ru'),
  ('cccccccc-0000-0000-0000-000000000003','c@x.ru') on conflict do nothing;
set role authenticated;

-- тест: имя, SQL, ожидание. Ошибки ловим и печатаем код.
create or replace function pg_temp.t(p_name text, p_sql text, p_expect text) returns void language plpgsql as $$
declare v text; ok boolean;
begin
  begin execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  ok := v like p_expect;
  raise notice '% %  →  %', case when ok then 'PASS' else 'FAIL' end, p_name, left(coalesce(v,'null'), 160);
end $$;
create or replace function pg_temp.as_user(u text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', u, false) $$;

select pg_temp.as_user('');
select pg_temp.t('аноним: state_get', $q$select state_get()::text$q$, 'ERR PT401%');

select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select pg_temp.t('до создания плана account = null', $q$select (state_get()->'account')::text$q$, 'null');
select pg_temp.t('ref отдаётся без плана', $q$select jsonb_array_length(state_get()#>'{ref,currencies}')::text$q$, '3');
select pg_temp.t('save без плана → 404', $q$select state_save('income','{}')::text$q$, 'ERR PT404%');
select pg_temp.t('bootstrap_user создаёт план', $q$select bootstrap_user('План А')#>>'{account,title}'$q$, 'План А');
select pg_temp.t('повторный bootstrap_user не создаёт второй', $q$select jsonb_array_length(bootstrap_user('Другой')->'accounts')::text$q$, '1');
select pg_temp.t('версии всех 7 доменов = 0', $q$select state_get()->>'versions'$q$,
  '{"debts": 0, "facts": 0, "gifts": 0, "income": 0, "savings": 0, "expenses": 0, "settings": 0}');
select pg_temp.t('allocation_rules разложены', $q$select jsonb_array_length(state_get()#>'{settings,allocation_rules}')::text$q$, '6');

-- доходы
select pg_temp.t('income: первая запись', $q$select state_save('income', '{
  "plan_years":[{"year":2027}],
  "payout_slots":[{"year":2027,"sort_order":1,"pay_day":10,"month_offset":1},{"year":2027,"sort_order":2,"pay_day":25,"window_to_day":15}],
  "tax_scales":[{"id":"ru","title":"НДФЛ"}],
  "tax_brackets":[{"scale_id":"ru","sort_order":1,"up_to":2400000,"rate":13},{"scale_id":"ru","sort_order":2,"rate":15}],
  "periods":[
    {"id":"p1","year":2027,"pay_date":"2027-01-09","window_start":"2026-12-16","window_end":"2026-12-31","note":"первая"},
    {"id":"p2","year":2027,"pay_date":"2027-01-23","window_start":"2027-01-01","window_end":"2027-01-15"}]
}')->>'version'$q$, '1');
select pg_temp.t('повтор того же патча ничего не меняет', $q$select state_save('income', jsonb_build_object('periods', state_get()#>'{income,periods}'))::text$q$, '%"changed": 0%"version": 1%');
select pg_temp.t('строка без колонки note: note сохраняется', $q$select state_save('income', '{"periods":[
    {"id":"p1","year":2027,"pay_date":"2027-01-09","window_start":"2026-12-16","window_end":"2026-12-31","income_net":50000}]}')#>>'{stats,periods}'$q$,
  '{"deleted": 1, "upserted": 1}');
select pg_temp.t('p1: note прежняя, income_net новая', $q$select (select e->>'note' || '/' || (e->>'income_net') from jsonb_array_elements(state_get()#>'{income,periods}') e where e->>'id'='p1')$q$, 'первая/50000');
select pg_temp.t('версия выросла до 2', $q$select state_get()#>>'{versions,income}'$q$, '2');
select pg_temp.t('устаревшая версия → 409', $q$select state_save('income','{"sick_leaves":[]}', null, 1)::text$q$, 'ERR PT409%');
select pg_temp.t('актуальная версия проходит', $q$select state_save('income','{"sick_leaves":[{"id":"s1","note":"x"}]}', null, 2)->>'version'$q$, '3');

-- ошибки патча и атомарность
select pg_temp.t('неизвестная колонка', $q$select state_save('income','{"periods":[{"id":"p9","foo":1}]}')::text$q$, 'ERR PT400%foo%');
select pg_temp.t('нет ключа', $q$select state_save('income','{"vacations":[{"title":"x"}]}')::text$q$, 'ERR PT400%id%');
select pg_temp.t('ключ повторяется', $q$select state_save('income','{"sick_leaves":[{"id":"a"},{"id":"a"}]}')::text$q$, 'ERR PT400%повтор%');
select pg_temp.t('чужая таблица в домене', $q$select state_save('income','{"goals":[]}')::text$q$, 'ERR PT400%goals%');
select pg_temp.t('неизвестный домен', $q$select state_save('stuff','{}')::text$q$, 'ERR PT400%');
select pg_temp.t('не массив', $q$select state_save('income','{"periods":{}}')::text$q$, 'ERR PT400%');
select pg_temp.t('битая дата', $q$select state_save('income','{"sick_leaves":[], "vacations":[{"id":"v","start_date":"2027-13-01","end_date":"2027-01-01"}]}')::text$q$, 'ERR 22008%');
select pg_temp.t('…и больничные не стёрлись (откат)', $q$select jsonb_array_length(state_get()#>'{income,sick_leaves}')::text$q$, '1');
select pg_temp.t('потомок без родителя → FK', $q$select state_save('income','{"tax_brackets":[{"scale_id":"nope","sort_order":1,"rate":1}]}')::text$q$, 'ERR 23503%');
select pg_temp.t('check constraint', $q$select state_save('income','{"payout_slots":[{"year":2027,"sort_order":1,"pay_day":40}]}')::text$q$, 'ERR 23514%');
select pg_temp.t('account_id из патча игнорируется', $q$select state_save('income','{"sick_leaves":[{"id":"s1","note":"x","account_id":"00000000-0000-0000-0000-000000000000"}]}')->>'changed'$q$, '0');

-- настройки
select pg_temp.t('валюта плана → USD', $q$select state_save('settings','{"account_settings":{"base_currency":"USD","rounding":10},"account":{"title":"Наш план"}}')->>'changed'$q$, '3');
select pg_temp.t('accounts синхронизирован', $q$select state_get()#>>'{account,base_currency}' || '/' || (state_get()#>>'{account,title}')$q$, 'USD/Наш план');
select pg_temp.t('null возвращает умолчание', $q$select state_save('settings','{"account_settings":{"base_currency":null}}')->>'changed'$q$, '1');
select pg_temp.t('…accounts снова RUB', $q$select state_get()#>>'{account,base_currency}'$q$, 'RUB');
select pg_temp.t('чужой ключ настроек', $q$select state_save('settings','{"account_settings":{"locale":"en"}}')::text$q$, 'ERR PT400%locale%');
select pg_temp.t('неизвестная валюта → FK', $q$select state_save('settings','{"account_settings":{"base_currency":"XXX"}}')::text$q$, 'ERR 23503%');
select pg_temp.t('allocation_rules: выключить этап', $q$select state_save('settings','{"allocation_rules":[{"stage_code":"gifts","enabled":false}]}')->>'changed'$q$, '1');
select pg_temp.t('allocation_rules: пустой массив не удаляет', $q$select state_save('settings','{"allocation_rules":[]}')->>'changed'$q$, '0');
select pg_temp.t('…этапов по-прежнему 6, gifts выключен', $q$select jsonb_array_length(state_get()#>'{settings,allocation_rules}') || '/' || (select e->>'enabled' || ':' || (e->>'priority') from jsonb_array_elements(state_get()#>'{settings,allocation_rules}') e where e->>'stage_code'='gifts')$q$, '6/false:2');
select pg_temp.t('fx_rates дописываются', $q$select state_save('settings','{"fx_rates":[{"base_code":"RUB","quote_code":"USD","rate_date":"2026-09-19","rate":0.011,"source":"cbr"}]}')->>'changed'$q$, '1');

-- накопления: каскад и круговой обмен
select pg_temp.t('savings: цель, этап, цикл, трата', $q$select state_save('savings','{
  "goals":[{"id":"g1","title":"Отпуск","kind_code":"bucket"},{"id":"g2","title":"Подушка","kind_code":"reserve","currency_code":"USD"}],
  "goal_milestones":[{"id":"m1","goal_id":"g1","target":18000,"deadline":"2027-09-01"}],
  "goal_cycles":[{"id":"c1","goal_id":"g1","amount":18000,"start_date":"2027-09-01"}],
  "goal_cycle_skips":[{"cycle_id":"c1","occurrence_key":"2028"}],
  "goal_transactions":[{"id":"t1","goal_id":"g1","date":"2027-09-02","amount":17000}]}')->>'changed'$q$, '6');
select pg_temp.t('state_get → state_save без изменений', $q$select state_save('savings', state_get()->'savings')->>'changed'$q$, '0');
select pg_temp.t('удаление цели уносит этапы, циклы, траты', $q$select state_save('savings','{"goals":[{"id":"g2","title":"Подушка","kind_code":"reserve","currency_code":"USD"}]}')->>'changed'$q$, '1');
select pg_temp.t('…этапы, циклы, пропуски, траты ушли каскадом', $q$select (state_get()->'savings')::text$q$, '%"goal_cycles": []%"goal_milestones": []%"goal_cycle_skips": []%"goal_transactions": []%');

-- факт и entered_by
select pg_temp.t('факт без item_key → 400', $q$select state_save('facts','{"expense_facts":[{"ym":"2027-01","category_id":"x"}]}')::text$q$, 'ERR PT400%item_key%');
select pg_temp.t('факт: entered_by = A', $q$select state_save('facts','{"expense_facts":[{"ym":"2027-01","category_id":"food","item_key":"","amount":100},{"ym":"2027-01","category_id":"home","item_key":"","amount":5,"entered_by":"cccccccc-0000-0000-0000-000000000003"}]}')->>'changed'$q$, '2');
select pg_temp.t('…обе строки подписаны A, присланный entered_by проигнорирован', $q$select string_agg(distinct e->>'entered_by', ',') from jsonb_array_elements(state_get()#>'{facts,expense_facts}') e$q$, 'aaaaaaaa-0000-0000-0000-000000000001');

-- второй участник
reset role; create temp table ids as select id as acc from accounts; grant select on ids to authenticated; set role authenticated;
select add_account_member((select acc from pg_temp.ids), 'b@x.ru', 'viewer');
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.t('viewer видит план', $q$select state_get()#>>'{account,role}' || '/' || jsonb_array_length(state_get()#>'{savings,goals}')$q$, 'viewer/1');
select pg_temp.t('viewer не пишет', $q$select state_save('facts','{"expense_facts":[]}')::text$q$, 'ERR PT403%');
select pg_temp.t('viewer меняет свой язык', $q$select state_save('settings','{"user_settings":{"locale":"en-US"}}')::text$q$, '%"user_settings": 1%');
select pg_temp.t('viewer не трогает настройки плана', $q$select state_save('settings','{"user_settings":{},"account_settings":{"rounding":1}}')::text$q$, 'ERR PT403%');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select pg_temp.t('язык B не виден A', $q$select state_get()#>>'{user,settings}'$q$, '{}');
select add_account_member((state_get()#>>'{account,id}')::uuid, 'b@x.ru', 'editor');
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.t('editor B правит один факт', $q$select state_save('facts', jsonb_build_object('expense_facts',
  (select jsonb_agg(case when e->>'category_id'='food' then e || '{"amount":150}' else e end) from jsonb_array_elements(state_get()#>'{facts,expense_facts}') e)))->>'changed'$q$, '1');
select pg_temp.t('…entered_by: food=B, home=A', $q$select string_agg((e->>'category_id') || '=' || left(e->>'entered_by',1), ',' order by e->>'category_id') from jsonb_array_elements(state_get()#>'{facts,expense_facts}') e$q$, 'food=b,home=a');

-- посторонний
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
select pg_temp.t('чужой: state_get(план)', $q$select state_get((select acc from pg_temp.ids))::text$q$, 'ERR PT403%');
select pg_temp.t('чужой: state_save по id плана', $q$select state_save('facts','{"expense_facts":[]}', (select acc from pg_temp.ids))::text$q$, 'ERR PT403%');
select pg_temp.t('чужой: RLS прячет строки', $q$select count(*)::text from expense_facts$q$, '0');
select pg_temp.t('служебная функция на чужой таблице', $q$select api_private.upsert('aaaaaaaa-0000-0000-0000-000000000001', 'account_members', '[]', null)::text$q$, 'ERR PT400%недоступна%');

-- очистка таблицы
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select pg_temp.t('пустой массив очищает таблицу', $q$select state_save('facts','{"expense_facts":[]}')->>'changed'$q$, '2');
select pg_temp.t('…фактов 0, версия facts = 3', $q$select jsonb_array_length(state_get()#>'{facts,expense_facts}') || '/' || (state_get()#>>'{versions,facts}')$q$, '0/3');

-- приглашённый участник не получает свой план
reset role; insert into auth.users values ('dddddddd-0000-0000-0000-000000000004','d@x.ru') on conflict do nothing; set role authenticated;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select add_account_member((select acc from pg_temp.ids), 'd@x.ru', 'editor');
select pg_temp.as_user('dddddddd-0000-0000-0000-000000000004');
select pg_temp.t('приглашённый: bootstrap_user открывает общий план', $q$select jsonb_array_length(bootstrap_user()->'accounts') || '/' || (bootstrap_user()#>>'{account,role}')$q$, '1/editor');
select pg_temp.as_user('');
select pg_temp.t('аноним: bootstrap_user', $q$select bootstrap_user()::text$q$, 'ERR PT401%');

select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select pg_temp.t('ответ содержит таблицу со значениями по умолчанию', $q$select state_save('income','{"sick_leaves":[{"id":"s0"}]}')#>>'{tables,sick_leaves}'$q$, '[{"id": "s0", "note": "", "end_date": null, "start_date": null}]');
