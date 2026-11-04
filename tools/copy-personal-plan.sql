-- Полная замена содержимого личного плана. Проверено для схемы проекта 04.11.2026.
-- Запускать целиком в Supabase SQL Editor с административными правами.
-- Перед окончательным запуском сохранить резервную копию второго плана.
-- На время операции закрыть приложение у обоих пользователей.
-- Сначала выполнить с ROLLBACK в конце. Для сохранения заменить его на COMMIT.
-- UUID ниже — accounts.id (ID плана), НЕ auth.users.id (ID пользователя).
begin isolation level serializable;
set local lock_timeout = '10s';
set local statement_timeout = '60s';

create temporary table plan_copy_report (
  table_name text, source_rows bigint, copied_rows bigint
) on commit drop;

do $copy$
declare
  source_plan uuid := '00000000-0000-0000-0000-000000000001'; -- ОТКУДА
  target_plan uuid := '00000000-0000-0000-0000-000000000002'; -- КУДА (заменить всё)
  r record;
  column_list text;
  select_list text;
  source_count bigint;
  copied_count bigint;
  differs boolean;
begin
  if source_plan = target_plan then
    raise exception 'Источник и получатель должны быть разными планами';
  end if;
  perform 1 from public.accounts
    where id in (source_plan, target_plan) order by id for update;
  if (select count(*) from public.accounts
      where id in (source_plan, target_plan) and plan_kind = 'personal') <> 2 then
    raise exception 'Оба UUID должны указывать на существующие личные планы';
  end if;

  -- Связанный с семьёй получатель требует отдельного разбора семейного учёта.
  -- Не отключаем защитные триггеры и не меняем семейную историю.
  if exists (select 1 from public.family_members where source_account_id = target_plan)
     or exists (select 1 from public.family_contributions where source_account_id = target_plan) then
    raise exception 'План-получатель связан с семейными взносами. Автоматическая замена остановлена';
  end if;

  -- Реестр API задаёт порядок: удаляем потомков раньше родителей.
  for r in
    select table_name, domain, load_order from public.api_domain_tables
    union all select 'account_settings', 'settings', 0
    order by domain desc, load_order desc, table_name desc
  loop
    execute format('delete from public.%I where account_id = $1', r.table_name)
      using target_plan;
  end loop;

  -- Идентичность получателя, его владелец и участники сохраняются.
  update public.accounts t
    set title = s.title, base_currency = s.base_currency, calendar_code = s.calendar_code
    from public.accounts s where s.id = source_plan and t.id = target_plan;

  -- Копируем все текущие колонки, включая снимки и новые поля миграций.
  -- Внутренние ID сохраняются: ключи таблиц составные (account_id, ...).
  for r in
    select table_name, domain, load_order from public.api_domain_tables
    union all select 'account_settings', 'settings', 0
    order by domain, load_order, table_name
  loop
    select string_agg(format('%I', a.attname), ', ' order by a.attnum),
           string_agg(case when a.attname = 'account_id' then '$2'
                      else format('s.%I', a.attname) end, ', ' order by a.attnum)
      into column_list, select_list
      from pg_catalog.pg_attribute a
      where a.attrelid = format('public.%I', r.table_name)::regclass
        and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
    execute format(
      'insert into public.%I (%s) select %s from public.%I s where s.account_id = $1',
      r.table_name, column_list, select_list, r.table_name)
      using source_plan, target_plan;
    get diagnostics copied_count = row_count;
    execute format('select count(*) from public.%I where account_id = $1', r.table_name)
      into source_count using source_plan;

    -- Проверка не только количества, но и содержимого каждой строки.
    execute format(
      'select exists (
        (select to_jsonb(s) - ''account_id'' from public.%1$I s where account_id = $1
         except all
         select to_jsonb(t) - ''account_id'' from public.%1$I t where account_id = $2)
        union all
        (select to_jsonb(t) - ''account_id'' from public.%1$I t where account_id = $2
         except all
         select to_jsonb(s) - ''account_id'' from public.%1$I s where account_id = $1)
      )', r.table_name)
      into differs using source_plan, target_plan;
    if differs or source_count <> copied_count then
      raise exception 'Проверка копирования таблицы % не пройдена', r.table_name;
    end if;
    insert into plan_copy_report values (r.table_name, source_count, copied_count);
  end loop;

  -- Увеличиваем версии получателя, чтобы старые вкладки не затёрли копию.
  -- Версии источника переносить нельзя.
  insert into public.state_versions as v (account_id, domain, version, updated_at, updated_by)
    select target_plan, domain, 1, now(), null from public.api_domain_tables group by domain
    on conflict (account_id, domain) do update
      set version = v.version + 1, updated_at = now(), updated_by = null;
end
$copy$;

select * from plan_copy_report order by table_name;

rollback; -- ПРОБНЫЙ запуск. Для сохранения заменить на commit;
