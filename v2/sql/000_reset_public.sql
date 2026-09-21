-- =====================================================================
-- Очистка схемы public в ТЕСТОВОМ проекте перед установкой v2.
-- Удаляет все таблицы и функции приложения. Пользователи (auth.users),
-- настройки входа и расширения Supabase не трогаются.
-- ВЫПОЛНЯТЬ ТОЛЬКО В ТЕСТОВОМ ПРОЕКТЕ.
-- =====================================================================
do $$
declare r record;
begin
  -- таблицы (cascade уносит их политики, индексы и внешние ключи)
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;

  -- функции приложения; функции расширений пропускаем
  for r in
    select p.oid::regprocedure as f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('drop function if exists %s cascade', r.f);
  end loop;
end $$;

-- проверка: оба числа должны быть 0
select
  (select count(*) from pg_tables where schemaname = 'public') as tables_left,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')) as functions_left;
