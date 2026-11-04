/* Публичные курсы ЦБ через JSON-зеркало. Финансовые данные не отправляются.
   Один ответ на календарный день; настройки плана хранят полученные курсы. */
import { todayISO } from './format.js';

export const FX_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

export function dailyRates(payload, today, base = 'RUB', codes = []) {
  const current = String(payload?.Date ?? '').slice(0, 10);
  const previous = String(payload?.PreviousDate ?? '').slice(0, 10);
  const usePrevious = current > today;
  const date = usePrevious ? previous : current;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new Error('Нет действующего курса');
  const rub = new Map([['RUB', 1]]);
  for (const value of Object.values(payload?.Valute ?? {})) {
    const nominal = Number(value.Nominal), amount = Number(usePrevious ? value.Previous : value.Value);
    if (nominal > 0 && Number.isFinite(nominal) && amount > 0 && Number.isFinite(amount)) rub.set(value.CharCode, amount / nominal);
  }
  const baseRate = rub.get(base);
  if (!baseRate) throw new Error('Нет курса базовой валюты');
  const rates = [...new Set(codes)].filter(code => code !== base && rub.has(code)).map(code => ({
    base_code: base, quote_code: code, rate_date: date, rate: rub.get(code) / baseRate,
    source: 'ЦБ РФ · cbr-xml-daily.ru',
  }));
  if (!rates.length) throw new Error('Нет курсов нужных валют');
  return { date, rates };
}

export function createFxUpdater(store, { fetcher = globalThis.fetch, day = todayISO, now = Date.now } = {}) {
  let key = '', appliedState, attemptedAt = 0, failed = false, payloadDay = '', payloadPromise;
  function ensure() {
    const state = store.state;
    if (!state || state.account?.plan_kind === 'family') return false;
    const base = store.config().get('base_currency');
    const codes = [...new Set([
      ...(state.savings?.goals ?? []).filter(g => !g.completed && !g.archived),
      ...(state.debts?.credit_cards ?? []), ...(state.income?.extra_incomes ?? []),
    ].map(row => row.currency_code).filter(code => code && code !== base))].sort();
    if (!codes.length) return false;
    const today = day(), account = state.account.id;
    const nextKey = JSON.stringify([account, base, codes, today]);
    if (key === nextKey && appliedState === state && (!failed || now() - attemptedAt < 60000)) return false;
    key = nextKey; appliedState = state; attemptedAt = now(); failed = false;
    store.setCurrentFx({ ...state.current_fx, loading: true, error: false });
    if (payloadDay !== today || !payloadPromise) {
      payloadDay = today;
      payloadPromise = Promise.resolve().then(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetcher(FX_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache', signal: controller.signal });
          if (!response.ok) throw new Error('Курсы недоступны');
          return await response.json();
        } finally { clearTimeout(timeout); }
      });
    }
    payloadPromise.then(payload => {
      if (key !== nextKey || store.state.account.id !== account) return;
      const result = dailyRates(payload, today, base, codes);
      store.setCurrentFx({ ...result, checkedOn: today, loading: false, error: false });
      if (store.state.account.can_edit) store.update('settings', settings => {
        const rows = settings.fx_rates ??= [];
        for (const rate of result.rates) {
          const index = rows.findIndex(r => r.base_code === rate.base_code && r.quote_code === rate.quote_code && r.rate_date === rate.rate_date);
          if (index < 0) rows.push(rate); else rows[index] = rate;
        }
      }, {history:false});
    }).catch(() => {
      if (key !== nextKey || store.state.account.id !== account) return;
      failed = true; payloadPromise = null;
      store.setCurrentFx({ ...store.state.current_fx, loading: false, error: true });
    });
    return true;
  }
  return { ensure };
}
