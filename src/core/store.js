/* ---------------------------------------------------------------------
   store.js — состояние плана, изменения по доменам и автосохранение.

   Загрузка:   await store.load()          → bootstrap_user: создаст план, если его нет
   Чтение:     store.state.income.periods  → строки таблиц как в базе (snake_case)
               store.config()              → настройки и справочники (core/config.js)
   Изменение:  store.update('income', income => { income.periods.push({...}); })
               store.setSetting('rounding', 10)      // null — вернуть умолчание
               store.setAccountTitle('Наш план')
   События:    store.subscribe(ev => ...)  → 'loaded' | 'change' | 'status' | 'conflict' | 'error'

   Как сохраняется. После изменения домен ждёт debounceMs (по умолчанию 500 мс),
   чтобы частые правки подряд ушли одним запросом. В state_save уходят только те
   таблицы домена, которые отличаются от последней сохранённой версии, и только
   изменившиеся ключи настроек. Сохранения одного домена идут строго по очереди,
   разные домены — независимо.

   После сохранения база возвращает записанные таблицы целиком, и они заменяют
   локальные: у новых строк появляются значения по умолчанию (note: '', locked:
   false и т. д.), порядок строк — по ключу. Порядок для показа задаёт sort_order.

   Конфликт. С каждым сохранением отправляется номер версии домена. Если домен
   уже изменили в другой вкладке или другой участник, база отвечает 409. Тогда
   домен перечитывается из базы, несохранённые правки этого домена отбрасываются,
   а подписчики получают событие 'conflict' — интерфейс должен сказать об этом.
--------------------------------------------------------------------- */

import { createConfig } from './config.js';

export const DOMAINS = ['settings', 'income', 'expenses', 'debts', 'savings', 'gifts', 'facts'];

const KV_KEYS = ['account_settings', 'user_settings'];

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isEmpty = obj => Object.keys(obj).length === 0;

/* Разница двух объектов «ключ → значение»: изменённые ключи со значением,
   удалённые — с null (в базе null означает «вернуть умолчание») */
function kvDiff(saved, current) {
  const out = {};
  for (const [k, v] of Object.entries(current ?? {})) {
    if (JSON.stringify(v) !== JSON.stringify(saved?.[k])) out[k] = v;
  }
  for (const k of Object.keys(saved ?? {})) {
    if (!(k in (current ?? {}))) out[k] = null;
  }
  return out;
}

function isConflict(error, status) {
  return status === 409 || error?.code === 'PT409';
}

export function createStore({ client, debounceMs = 500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!client?.rpc) throw new Error('createStore: нужен клиент Supabase');

  let state = null;
  let config = null;
  const saved = {};          // domain → { tables: {name: json}, kv: {...}, title }
  const timers = {};         // domain → таймер отложенного сохранения
  const inflight = {};       // domain → промис идущего сохранения
  const again = {};          // domain → за время сохранения появились новые правки
  const errors = {};         // domain → последняя ошибка сохранения
  const listeners = new Set();

  function emit(type, payload = {}) {
    for (const fn of listeners) {
      try { fn({ type, ...payload }); } catch (e) { console.error(e); }
    }
  }

  function requireState() {
    if (!state) throw new Error('Состояние ещё не загружено');
  }

  function requireDomain(domain) {
    if (!DOMAINS.includes(domain)) throw new Error(`Неизвестный домен: ${domain}`);
  }

  /* ------------------------------------------------ снимки сохранённого */

  function snapshotDomain(domain) {
    const tables = {};
    for (const [name, rows] of Object.entries(state[domain] ?? {})) {
      if (Array.isArray(rows)) tables[name] = JSON.stringify(rows);
    }
    const snap = { tables };
    if (domain === 'settings') {
      snap.kv = {
        account_settings: clone(state.settings?.account_settings ?? {}),
        user_settings: clone(state.user?.settings ?? {}),
      };
      snap.title = state.account?.title ?? null;
    }
    saved[domain] = snap;
  }

  function kvCurrent(key) {
    return key === 'user_settings' ? state.user?.settings : state.settings?.account_settings;
  }

  /* Патч домена: только то, что отличается от сохранённого.
     sent — что пометить сохранённым, если запрос пройдёт. */
  function buildPatch(domain) {
    const patch = {};
    const sent = { tables: {}, kv: {}, title: undefined };
    const snap = saved[domain] ?? { tables: {} };

    for (const [name, rows] of Object.entries(state[domain] ?? {})) {
      if (!Array.isArray(rows)) continue;
      const json = JSON.stringify(rows);
      if (json !== snap.tables[name]) {
        patch[name] = JSON.parse(json);
        sent.tables[name] = json;
      }
    }

    if (domain === 'settings') {
      for (const key of KV_KEYS) {
        const cur = kvCurrent(key) ?? {};
        const diff = kvDiff(snap.kv?.[key], cur);
        if (!isEmpty(diff)) {
          patch[key] = diff;
          sent.kv[key] = clone(cur);
        }
      }
      const title = state.account?.title ?? null;
      if (title !== snap.title && title) {
        patch.account = { title };
        sent.title = title;
      }
    }
    return { patch, sent };
  }

  function markSent(domain, sent) {
    const snap = saved[domain] ?? (saved[domain] = { tables: {} });
    Object.assign(snap.tables, sent.tables);
    if (domain === 'settings') {
      snap.kv = { ...(snap.kv ?? {}), ...sent.kv };
      if (sent.title !== undefined) snap.title = sent.title;
    }
  }

  /* База возвращает записанные таблицы целиком, со значениями по умолчанию для
     колонок, которых не было в патче. Подставляем их в состояние, чтобы движок
     видел то же, что лежит в базе. Если за время запроса таблицу снова изменили,
     оставляем локальную версию: она уйдёт следующим сохранением. */
  function acceptServerTables(domain, sent, tables) {
    if (!tables) return;
    let replaced = false;
    for (const [name, rows] of Object.entries(tables)) {
      if (!Array.isArray(rows) || !(name in sent.tables)) continue;
      const local = JSON.stringify(state[domain]?.[name] ?? null);
      if (local !== sent.tables[name]) continue;
      const json = JSON.stringify(rows);
      saved[domain].tables[name] = json;
      if (json !== local) {
        state[domain][name] = rows;
        replaced = true;
      }
    }
    if (replaced) {
      config = null;
      emit('change', { domain, fromServer: true });
    }
  }

  /* ------------------------------------------------ статус */

  function status() {
    if (DOMAINS.some(d => errors[d])) return 'error';
    if (DOMAINS.some(d => inflight[d])) return 'saving';
    if (DOMAINS.some(d => timers[d])) return 'pending';
    return 'saved';
  }

  function emitStatus() {
    emit('status', { status: status(), errors: { ...errors } });
  }

  /* ------------------------------------------------ загрузка */

  function applyLoaded(data) {
    if (!data || typeof data !== 'object') throw new Error('База вернула пустое состояние');
    // Без справочников приложение работать не может: настройки, валюты, этапы — всё там
    const empty = ['setting_defaults', 'currencies', 'allocation_stages'].filter(n => !data.ref?.[n]?.length);
    if (empty.length) {
      throw new Error(`База вернула пустые справочники (${empty.map(n => 'ref_' + n).join(', ')}). `
        + 'Обычно это значит, что у таблиц включён RLS без политики чтения: выполните 002_api.sql заново.');
    }
    state = data;
    for (const d of DOMAINS) {
      state[d] = state[d] ?? {};
      snapshotDomain(d);
    }
    config = null;
  }

  async function load({ title } = {}) {
    // параметр передаём всегда: PostgREST ищет функцию по именам аргументов, и вызов
    // без параметров он у bootstrap_user(p_title) не находит — «not found in the schema cache»
    const { data, error } = await client.rpc('bootstrap_user', { p_title: title || 'Мой план' });
    if (error) throw toError(error, 'Не удалось загрузить план');
    applyLoaded(data);
    emit('loaded', { state });
    return state;
  }

  /* Перечитать всё из базы. Несохранённые правки теряются, поэтому сначала flush. */
  async function reload() {
    await flush();
    const { data, error } = await client.rpc('state_get', { p_account: state?.account?.id ?? null });
    if (error) throw toError(error, 'Не удалось перечитать план');
    applyLoaded(data);
    emit('change', { domain: null });
    return state;
  }

  /* Перечитать один домен после конфликта */
  async function reloadDomain(domain) {
    const { data, error } = await client.rpc('state_get', { p_account: state.account.id });
    if (error) throw toError(error, 'Не удалось перечитать план');
    state[domain] = data[domain] ?? {};
    state.versions = { ...(state.versions ?? {}), [domain]: data.versions?.[domain] ?? 0 };
    if (domain === 'settings') {
      state.account = data.account;
      state.accounts = data.accounts;
    }
    config = null;
    snapshotDomain(domain);
  }

  /* ------------------------------------------------ сохранение */

  function schedule(domain) {
    if (timers[domain]) clearTimer(timers[domain]);
    timers[domain] = setTimer(() => { timers[domain] = null; save(domain); }, debounceMs);
    emitStatus();
  }

  async function save(domain) {
    if (timers[domain]) { clearTimer(timers[domain]); timers[domain] = null; }
    if (inflight[domain]) { again[domain] = true; return inflight[domain]; }

    const { patch, sent } = buildPatch(domain);
    if (isEmpty(patch)) {
      errors[domain] = null;
      emitStatus();
      return;
    }

    inflight[domain] = (async () => {
      emitStatus();
      const { data, error, status: http } = await client.rpc('state_save', {
        p_domain: domain,
        p_patch: patch,
        p_account: state.account.id,
        p_version: state.versions?.[domain] ?? null,
      });

      if (!error) {
        errors[domain] = null;
        markSent(domain, sent);
        if (data?.version != null) state.versions = { ...(state.versions ?? {}), [domain]: data.version };
        acceptServerTables(domain, sent, data?.tables);
        return;
      }

      if (isConflict(error, http)) {
        again[domain] = false;
        errors[domain] = null;
        try {
          await reloadDomain(domain);
          emit('conflict', { domain });
          emit('change', { domain });
        } catch (e) {
          errors[domain] = toError(e, 'Не удалось перечитать план');
          emit('error', { domain, error: errors[domain] });
        }
        return;
      }

      errors[domain] = toError(error, 'Не удалось сохранить');
      emit('error', { domain, error: errors[domain] });
    })();

    try {
      await inflight[domain];
    } finally {
      inflight[domain] = null;
      if (again[domain]) {
        again[domain] = false;
        await save(domain);
      } else {
        emitStatus();
      }
    }
  }

  /* Отправить всё, что ждёт, и дождаться ответа (перед уходом со страницы, перед reload) */
  async function flush() {
    await Promise.all(DOMAINS.map(d => (timers[d] || inflight[d] || errors[d]) ? save(d) : null));
  }

  function hasPending() {
    return DOMAINS.some(d => timers[d] || inflight[d] || errors[d]);
  }

  /* ------------------------------------------------ изменения */

  function update(domain, mutate) {
    requireState();
    requireDomain(domain);
    if (domain !== 'settings' && !state.account?.can_edit) {
      throw new Error('У вас доступ только на просмотр этого плана');
    }
    mutate(state[domain], state);
    config = null;
    emit('change', { domain });
    schedule(domain);
  }

  /* Настройка по ключу. Область (план или пользователь) берётся из справочника.
     null или undefined — удалить своё значение и вернуться к умолчанию. */
  function setSetting(key, value) {
    requireState();
    const def = (state.ref?.setting_defaults ?? []).find(d => d.key === key);
    if (!def) throw new Error(`Неизвестная настройка: ${key}`);
    if (def.scope === 'account' && !state.account?.can_edit) {
      throw new Error('У вас доступ только на просмотр этого плана');
    }
    const target = def.scope === 'user'
      ? (state.user.settings = state.user.settings ?? {})
      : (state.settings.account_settings = state.settings.account_settings ?? {});
    if (value === null || value === undefined) delete target[key];
    else target[key] = value;
    if (def.scope === 'account' && (key === 'base_currency' || key === 'calendar_code')) {
      state.account[key] = value ?? def.value;
    }
    config = null;
    emit('change', { domain: 'settings' });
    schedule('settings');
  }

  function setAccountTitle(title) {
    requireState();
    const t = String(title ?? '').trim();
    if (!t) return;
    if (!state.account?.can_edit) throw new Error('У вас доступ только на просмотр этого плана');
    state.account.title = t;
    const row = state.accounts?.find(a => a.id === state.account.id);
    if (row) row.title = t;
    emit('change', { domain: 'settings' });
    schedule('settings');
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    get state() { return state; },
    config() {
      requireState();
      return config ?? (config = createConfig(state));
    },
    status,
    load, reload, update, setSetting, setAccountTitle,
    save, flush, hasPending, subscribe,
  };
}

/* Ошибка Supabase → Error с понятным текстом; исходная — в cause */
export function toError(err, fallback) {
  if (err instanceof Error) return err;
  let msg = err?.message || fallback || 'Ошибка';
  // частая причина на новой базе: SQL выполнен, но PostgREST ещё не перечитал схему
  if (/schema cache/i.test(msg)) {
    msg += '. Похоже, в этой базе не выполнен 002_api.sql — либо PostgREST не перечитал схему.'
      + ' Выполните в SQL Editor: notify pgrst, \'reload schema\';';
  }
  const e = new Error(msg);
  e.code = err?.code;
  e.details = err?.details;
  e.cause = err;
  return e;
}
