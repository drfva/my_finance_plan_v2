/* ---------------------------------------------------------------------
   fx.js — перевод сумм между валютами по курсам из fx_rates.

   Курс в строке fx_rates (base_code, quote_code, rate_date, rate) — сколько
   единиц base_code стоит одна единица quote_code: RUB/USD 92,5 значит
   1 $ = 92,5 ₽. Обратная пара (USD/RUB) тоже понимается.

   На дату берётся последний курс не позже даты; если таких нет — самый ранний
   из имеющихся. Нет ни одного курса — перевод невозможен (null), и вызывающий
   код должен сказать об этом, а не молча считать курс равным единице.
--------------------------------------------------------------------- */

export function createFx(fxRates = [], base = 'RUB') {
  const pairs = new Map();          // quote → [{ date, rate }] в базовой валюте за единицу
  function add(code, date, rate) {
    if (!(rate > 0)) return;
    if (!pairs.has(code)) pairs.set(code, []);
    pairs.get(code).push({ date, rate });
  }
  for (const r of fxRates) {
    const rate = Number(r.rate);
    if (r.base_code === base) add(r.quote_code, r.rate_date, rate);
    else if (r.quote_code === base) add(r.base_code, r.rate_date, 1 / rate);
  }
  for (const list of pairs.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  /* Сколько базовой валюты за единицу code на дату */
  function rateOn(code, date) {
    if (!code || code === base) return 1;
    const list = pairs.get(code);
    if (!list?.length) return null;
    let found = null;
    for (const x of list) { if (!date || x.date <= date) found = x; else break; }
    return (found ?? list[0]).rate;
  }

  return {
    base,
    rateOn,
    has: (code, date) => rateOn(code, date) !== null,
    toBase(amount, code, date) {
      const r = rateOn(code, date);
      return r === null ? null : amount * r;
    },
    fromBase(amount, code, date) {
      const r = rateOn(code, date);
      return r === null ? null : amount / r;
    },
  };
}
