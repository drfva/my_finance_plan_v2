/* ---------------------------------------------------------------------
   config.js — настройки и справочники.

   Код приложения спрашивает значение по ключу и не знает, откуда оно:
   своё значение плана или пользователя, а если его нет — умолчание
   из ref_setting_defaults.

     const cfg = createConfig(state);        // state — ответ bootstrap_user / state_get
     cfg.get('fact_tolerance_pct')           → 5
     cfg.list('expense_modes')               → строки справочника
     cfg.byCode('currencies', 'USD')         → { code, title, symbol }
     cfg.stages()                            → этапы распределения в порядке приоритета

   Не путать с config.js в корне репозитория: тот хранит адреса Supabase.
--------------------------------------------------------------------- */

import { createFormat } from './format.js';

const REF_NAMES = [
  'allocation_stages', 'goal_kinds', 'expense_modes', 'split_modes',
  'period_units', 'currencies', 'calendars', 'calendar_days', 'setting_defaults',
];

const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

export function createConfig(state) {
  const ref = state?.ref ?? {};
  const defaults = new Map((ref.setting_defaults ?? []).map(d => [d.key, d]));
  const accountSettings = state?.settings?.account_settings ?? {};
  const userSettings = state?.user?.settings ?? {};
  const account = state?.account ?? null;

  function definition(key) {
    const d = defaults.get(key);
    if (!d) throw new Error(`Неизвестная настройка: ${key}`);
    return d;
  }

  function ownStore(d) {
    return d.scope === 'user' ? userSettings : accountSettings;
  }

  /* Значение настройки: своё, иначе умолчание из справочника */
  function get(key) {
    const d = definition(key);
    const own = ownStore(d);
    return has(own, key) ? own[key] : d.value;
  }

  /* Задано ли значение явно ('own') или берётся умолчание ('default') */
  function source(key) {
    return has(ownStore(definition(key)), key) ? 'own' : 'default';
  }

  /* Все настройки с описанием — для экрана настроек */
  function all(scope) {
    return [...defaults.values()]
      .filter(d => !scope || d.scope === scope)
      .map(d => ({
        key: d.key,
        scope: d.scope,
        title: d.title,
        description: d.description,
        value: get(d.key),
        defaultValue: d.value,
        isDefault: source(d.key) === 'default',
      }));
  }

  function list(name) {
    if (!REF_NAMES.includes(name)) throw new Error(`Неизвестный справочник: ${name}`);
    return ref[name] ?? [];
  }

  function byCode(name, code) {
    return list(name).find(r => r.code === code) ?? null;
  }

  /* Этапы распределения: порядок и включение — из allocation_rules плана,
     названия — из справочника. Этап, которого ещё нет в плане (добавлен в
     справочник позже), идёт со своим приоритетом по умолчанию и включён. */
  function stages() {
    const rules = new Map((state?.settings?.allocation_rules ?? []).map(r => [r.stage_code, r]));
    return list('allocation_stages')
      .map(s => {
        const r = rules.get(s.code);
        return {
          code: s.code,
          title: s.title,
          description: s.description,
          priority: r ? r.priority : s.default_priority,
          enabled: r ? r.enabled : true,
          params: r?.params ?? {},
          configured: Boolean(r),
        };
      })
      .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
  }

  function currency(code = get('base_currency')) {
    return byCode('currencies', code);
  }

  /* Форматтер, настроенный по локали, валюте и округлению плана */
  function formatter() {
    return createFormat({
      locale: get('locale'),
      currency: get('base_currency'),
      rounding: get('rounding'),
      currencies: list('currencies'),
    });
  }

  return Object.freeze({
    account,
    role: account?.role ?? null,
    canEdit: Boolean(account?.can_edit),
    get, source, all, list, byCode, stages, currency, formatter,
  });
}
