/* Подготовка пакета Edge Function без npm-зависимостей и копии алгоритма
   в исходниках: сохраняем относительные импорты общего расчетного движка. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'src');
const target = path.join(root, 'supabase/functions/_shared/finance');
const visited = new Set();
async function copy(file) {
  const absolute = path.resolve(source, file);
  if (!absolute.startsWith(source + path.sep)) throw new Error('Импорт вне src');
  if (visited.has(absolute)) return;
  visited.add(absolute);
  const code = await fs.readFile(absolute, 'utf8');
  const output = path.join(target, path.relative(source, absolute));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, code);
  for (const match of code.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) throw new Error(`Неожиданная зависимость: ${match[1]}`);
    await copy(path.relative(source, path.resolve(path.dirname(absolute), match[1])));
  }
}
await copy('core/family-worker.js');
console.log(`Пакет family-worker подготовлен: ${visited.size} общих модулей`);
