const KEY = 'finance-theme';
const normalize = value => ['light','dark'].includes(value) ? value : 'system';

export function readTheme(storage) {
  try { return normalize((storage??globalThis.localStorage)?.getItem(KEY)); } catch { return 'system'; }
}

export function applyTheme(value, { root = globalThis.document?.documentElement, storage } = {}) {
  const theme = normalize(value);
  if (theme === 'system') root?.removeAttribute('data-theme');
  else root?.setAttribute('data-theme', theme);
  try { (storage??globalThis.localStorage)?.setItem(KEY, theme); } catch { /* В закрытом хранилище выбор действует до перезагрузки. */ }
  return theme;
}
