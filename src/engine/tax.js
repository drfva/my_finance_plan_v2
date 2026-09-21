/* ---------------------------------------------------------------------
   tax.js — налог по шкале.

   Шкала (tax_scales) — набор ступеней (tax_brackets): верхняя граница дохода
   up_to (null — без границы) и ставка rate В ПРОЦЕНТАХ (13 = 13 %). Каждая ставка
   применяется только к части дохода внутри своей ступени.

   Для года выплаты берётся шкала с наибольшим valid_from_year, не позже года.
   cumulative = true — налог нарастающим итогом за календарный год (как НДФЛ):
   налог выплаты = налог(набрано + выплата) − налог(набрано).
   cumulative = false — каждая выплата облагается отдельно.
--------------------------------------------------------------------- */

const top = b => (b.up_to === null || b.up_to === undefined || b.up_to === '' ? Infinity : Number(b.up_to));

export function sortBrackets(brackets) {
  return [...brackets].sort((a, b) => top(a) - top(b) || (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/* Налог с суммы дохода по ступеням (без округления) */
export function taxOn(amount, brackets) {
  let tax = 0;
  let lower = 0;
  for (const b of sortBrackets(brackets)) {
    if (amount <= lower) break;
    const upper = top(b);
    tax += (Math.min(amount, upper) - lower) * Number(b.rate) / 100;
    lower = upper;
  }
  return tax;
}

/* Шкала на год: { scale, brackets } или null */
export function scaleForYear(scales, brackets, year) {
  const scale = [...scales]
    .filter(s => Number(s.valid_from_year ?? 0) <= year)
    .sort((a, b) => Number(b.valid_from_year ?? 0) - Number(a.valid_from_year ?? 0))[0];
  if (!scale) return null;
  return { scale, brackets: sortBrackets(brackets.filter(b => b.scale_id === scale.id)) };
}

/* Налог с выплаты при уже набранном за год доходе */
export function taxForPayment(gross, cumBefore, scale, round = Math.round) {
  if (!scale) return 0;
  if (!scale.scale.cumulative) return round(taxOn(gross, scale.brackets));
  return round(taxOn(cumBefore + gross, scale.brackets) - taxOn(cumBefore, scale.brackets));
}

/* Из каких ставок сложился налог выплаты: [{ rate, amount }] по ступеням.
   Нарастающая шкала: облагается отрезок [cumBefore, cumBefore + gross]. */
export function taxParts(gross, cumBefore, scale, round = Math.round) {
  if (!scale || !(gross > 0)) return [];
  const from = scale.scale.cumulative ? cumBefore : 0;
  const to = from + gross;
  const out = [];
  let lower = 0;
  for (const b of sortBrackets(scale.brackets)) {
    const upper = top(b);
    const slice = Math.min(to, upper) - Math.max(from, lower);
    if (slice > 0) out.push({ rate: Number(b.rate), amount: round(slice * Number(b.rate) / 100) });
    lower = upper;
    if (lower >= to) break;
  }
  return out;
}

/* Какой gross даёт указанную сумму на руки (для нарастающего итога по введённым фактам) */
export function grossFromNet(net, cumBefore, scale) {
  if (!(net > 0) || !scale) return Math.max(0, net || 0);
  const br = scale.brackets;
  const netOf = g => (scale.scale.cumulative
    ? g - (taxOn(cumBefore + g, br) - taxOn(cumBefore, br))
    : g - taxOn(g, br));
  let lo = net;
  let hi = net * 2 + 1;
  for (let k = 0; k < 20 && netOf(hi) < net; k++) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (netOf(mid) < net) lo = mid; else hi = mid;
  }
  return hi;
}

/* Оценка «на руки в месяц» при окладе gross: налог с годового дохода / 12 */
export function estimateMonthlyNet(grossMonthly, scale, round = Math.round) {
  if (!scale) return round(grossMonthly);
  return round(grossMonthly - taxOn(grossMonthly * 12, scale.brackets) / 12);
}
