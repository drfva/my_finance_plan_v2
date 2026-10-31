import fs from 'node:fs/promises';
const root = new URL('../',import.meta.url);
const sql = (await fs.readdir(new URL('v2/sql/',root))).filter(f=>/^\d/.test(f)&&!f.startsWith('000')).sort().map(f=>`v2/sql/${f}`);
const migrations = (await fs.readdir(new URL('supabase/migrations/',root))).filter(f=>f.endsWith('.sql')).sort().map(f=>`supabase/migrations/${f}`);
const sources = [...sql,...migrations];
const blocks = await Promise.all(sources.map(async file=>`\n-- SOURCE: ${file}\n${(await fs.readFile(new URL(file,root),'utf8')).replace(/\r\n/g,'\n').replace(/^\s*(?:begin|commit);\s*$/gmi,'')}`));
const header = `-- Финансы v2: установка в чистый проект Supabase одним запуском.
-- Требуются auth.users, auth.uid(), роли anon, authenticated, service_role.
-- Сформировано tools/build-install.mjs из v2/sql/001...010 и supabase/migrations.
-- Сброс данных (000_reset_public.sql) не включён.
-- Для существующей базы применяйте отдельную новую миграцию.
begin;\n`;
await fs.writeFile(new URL('v2/install.sql',root),header+blocks.join('\n')+"\nnotify pgrst, 'reload schema';\ncommit;\n");
console.log(`Собрано ${sources.length} SQL-файлов`);
