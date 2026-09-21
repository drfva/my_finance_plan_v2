#!/bin/sh
# Пересоздаёт тестовую базу и прогоняет test_002_api.sql
cd "$(dirname "$0")"
P="psql -h /tmp -U postgres -q"
$P -c "drop database if exists t" -c "create database t" 2>/dev/null
$P -d t -c "drop role if exists anon" -c "drop role if exists authenticated" >/dev/null 2>&1
$P -d t -v ON_ERROR_STOP=1 -f 000_supabase_stub.sql >/dev/null 2>&1
$P -d t -v ON_ERROR_STOP=1 -f ../v2/sql/001_schema.sql 2>&1 | grep -v NOTICE
$P -d t -v ON_ERROR_STOP=1 -f ../v2/sql/002_api.sql    2>&1 | grep -v NOTICE
$P -d t -v ON_ERROR_STOP=1 -f ../v2/sql/002_api.sql    2>&1 | grep -v NOTICE   # повторный запуск
$P -d t -f test_002_api.sql 2>&1 | grep -E "PASS|FAIL|ERROR" | sed 's/^psql:[^ ]* NOTICE:  //'
