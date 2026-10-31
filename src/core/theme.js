const KEY = 'finance-theme';
const normalize = value => ['light','dark'].includes(value) ? value : 'system';
let runtimeTheme;

export const currentTheme = () => runtimeTheme ?? readTheme();
export const nextTheme = value => ({light:'dark',dark:'system',system:'light'})[normalize(value)];

export function readTheme(storage) {
  try { return normalize((storage??globalThis.localStorage)?.getItem(KEY)); } catch { return 'system'; }
}

export function applyTheme(value, { root = globalThis.document?.documentElement, storage } = {}) {
  const theme = normalize(value);
  runtimeTheme = theme;
  if (theme === 'system') root?.removeAttribute('data-theme');
  else root?.setAttribute('data-theme', theme);
  try { (storage??globalThis.localStorage)?.setItem(KEY, theme); } catch { /* В закрытом хранилище выбор действует до перезагрузки. */ }
  return theme;
}
