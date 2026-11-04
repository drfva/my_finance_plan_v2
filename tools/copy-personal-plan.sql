-- Полная замена содержимого личного плана. Проверено для схемы проекта 04.11.2026.
-- Запускать целиком в Supabase SQL Editor с административными правами.
-- Перед окончательным запуском сохранить резервную копию второго плана.
-- На время операции закрыть приложение у обоих пользователей.
-- Если получатель ранее вышел из семьи, отвязать старые семейные записи от
-- заменяемого личного плана, сохранив участников, суммы и снимки взносов.
-- Сначала выполнить с dry_run := true. Для сохранения поставить false.
-- UUID ниже — accounts.id (ID плана), НЕ auth.users.id (ID пользователя).
-- Это один самостоятельный блок: внешние BEGIN/COMMIT и временные таблицы не нужны.
do $copy$
declare
  source_plan uuid := '00000000-0000-0000-0000-000000000001'; -- ОТКУДА
  target_plan uuid := '00000000-0000-0000-0000-000000000002'; -- КУДА (заменить всё)
  dry_run boolean := true; -- true = проверка с откатом; false = СОХРАНИТЬ
  r record;
  column_list text;
  select_list text;
  source_count bigint;
  copied_count bigint;
  differs boolean;
  checked_tables integer := 0;
begin
  perform set_config('lock_timeout', '10s', true);
  -- Вложенный блок позволяет откатить всю пробную замену, включая семейные связи.
  begin
  -- Пока копируем, блокируем запись в задействованные таблицы. Чтение разрешено.
  -- Это обеспечивает согласованную копию даже при запуске одного DO без BEGIN.
  for r in
    select table_name from public.api_domain_tables
    union select unnest(array['accounts','account_settings','state_versions',
                             'api_domain_tables','family_members','family_contributions'])
    order by table_name
  loop
    execute format('lock table public.%I in share row exclusive mode', r.table_name);
  end loop;
  if source_plan = target_plan then
    raise exception 'Источник и получатель должны быть разными планами';
  end if;
  perform 1 from public.accounts
    where id in (source_plan, target_plan) order by id for update;
  if (select count(*) from public.accounts
      where id in (source_plan, target_plan) and plan_kind = 'personal') <> 2 then
    raise exception 'Оба UUID должны указывать на существующие личные планы';
  end if;

  -- Выход из семьи сохраняет исторические связи. Активные связи запрещены.
  perform 1 from public.family_members m
    where m.source_account_id = target_plan or m.id in (
      select c.member_id from public.family_contributions c where c.source_account_id = target_plan
    ) order by m.id for update;
  if exists (select 1 from public.family_members where source_account_id = target_plan and active)
     or exists (select 1 from public.family_contributions c
                join public.family_members m on m.id = c.member_id
                where c.source_account_id = target_plan and m.active) then
    raise exception 'У получателя есть активная семейная связь. Сначала выйдите из семьи';
  end if;

  -- NULL разрешён схемой и защитой снимков. После замены старые period_id
  -- не должны привязывать семейные взносы к новым личным выплатам.
  -- Суммы, даты, участники и allocation_snapshot сохраняются без изменений.
  update public.family_contributions set source_account_id = null
    where source_account_id = target_plan;
  update public.family_members set source_account_id = null, revision = revision + 1
    where source_account_id = target_plan and not active;

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
    checked_tables := checked_tables + 1;
    raise notice '%: источник %, скопировано %', r.table_name, source_count, copied_count;
  end loop;

  -- Увеличиваем версии получателя, чтобы старые вкладки не затёрли копию.
  -- Версии источника переносить нельзя.
  insert into public.state_versions as v (account_id, domain, version, updated_at, updated_by)
    select target_plan, domain, 1, now(), null from public.api_domain_tables group by domain
    on conflict (account_id, domain) do update
      set version = v.version + 1, updated_at = now(), updated_by = null;
  if dry_run then
    raise exception sqlstate 'PZ001' using message = 'Пробный перенос: откатить изменения';
  end if;
  exception when sqlstate 'PZ001' then
    if not dry_run then raise; end if;
    raise notice 'Проверка пройдена (% таблиц). Все изменения отменены. Для переноса установите dry_run := false.', checked_tables;
    return;
  end;
  raise notice 'Перенос завершён: проверено % таблиц. Изменения сохранятся при успешном завершении транзакции.', checked_tables;
end
$copy$;
