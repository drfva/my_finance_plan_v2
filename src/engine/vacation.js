/* ---------------------------------------------------------------------
   vacation.js — отпускные.

   Считаем по Положению № 922 в начисленных суммах (gross), а «на руки»
   получается уже после налога — его удерживает income.js при выплате.

   Средний дневной заработок:
     расчётный период   = 12 календарных месяцев до месяца начала отпуска;
     доход месяца       = monthGross(y, m) — оклад и премии до налога; отпускные,
                          больничные и подарки в него не входят;
     индексация         = п. 16: если оклады подняли всем (у записи оклада стоит
                          indexed), заработок до повышения умножается на
                          новый оклад / старый; персональное повышение не индексирует;
     коэффициент месяца = avg_days_in_month (29,3) за полностью отработанный месяц;
                          если в месяце были исключаемые дни (больничный, другой отпуск),
                          он считается неполным: avg_days_in_month / дней в месяце ×
                          (дней в месяце − исключаемые дни) — так предписывает
                          Положение № 922 (п. 10);
     средний дневной    = Σ доходов / Σ коэффициентов.
   Отпускные по формуле = округл(средний дневной × календарных дней отпуска).

   Какая сумма идёт в план: pay_manual = true — pay_amount (введено вручную),
   иначе — по формуле, каждый раз заново.

   Деление по выплатам: отпускные распределяются между выплатами пропорционально
   дням отпуска, попавшим в расчётный период каждой выплаты. Отпуск 10.08–17.08
   при выплатах за 01.08–15.08 и 16.08–31.08 делится как 6 и 2 дня. Остаток от
   округления уходит в последнюю часть, чтобы сумма частей совпадала с отпускными.
--------------------------------------------------------------------- */

import { parts, daysInMonth, monthsBefore, monthEnd, daysInclusive, overlap } from './dates.js';
import { rateOn, daysInWindow } from './salary.js';

/* Календарные дни месяца, попавшие в перечисленные периоды */
function daysInMonthFrom(y, m, ranges) {
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = monthEnd(y, m);
  let days = 0;
  for (const r of ranges) {
    if (!r.start_date || !r.end_date) continue;
    const o = overlap(r.start_date, r.end_date, from, to);
    if (o) days += daysInclusive(o.from, o.to);
  }
  return days;
}

/* Коэффициент индексации месяца: перемножаем все повышения «для всех»,
   которые случились после этого месяца и до начала отпуска. */
function raiseFactor(y, m, start, rates) {
  const end = monthEnd(y, m);
  let k = 1;
  for (const r of rates) {
    if (r.indexed !== true) continue;                 // персональное повышение не индексирует
    const from = r.effective_from;
    if (!from || from <= end || from > start) continue;
    const before = rateOn(rates, addDaysBefore(from));
    const now = Number(r.amount) || 0;
    const was = Number(before?.amount) || 0;
    if (was > 0 && now > was) k *= now / was;
  }
  return k;
}

/* День перед датой — чтобы взять оклад, действовавший до повышения */
function addDaysBefore(date) {
  const t = Date.parse(date) - 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/* Средний дневной заработок на дату начала отпуска */
export function averageDailyEarnings({
  start, monthGross, monthIncome, rates = [], sickLeaves = [], vacations = [], excludeVacationId = null, avgDaysInMonth = 29.3,
}) {
  const income = monthGross ?? monthIncome ?? (() => 0);
  const { y, m } = parts(start);
  const otherVacations = vacations.filter(v => v.id !== excludeVacationId);
  const months = monthsBefore(y, m, 12).map(mo => {
    const base = Number(income(mo.y, mo.m)) || 0;
    const factor = raiseFactor(mo.y, mo.m, start, rates);
    const dim = daysInMonth(mo.y, mo.m);
    const sickDays = Math.min(daysInMonthFrom(mo.y, mo.m, sickLeaves), dim);
    const vacDays = Math.min(daysInMonthFrom(mo.y, mo.m, otherVacations), dim);
    const excludedDays = Math.min(sickDays + vacDays, dim);
    const workedDays = dim - excludedDays;
    const coef = excludedDays > 0 ? (avgDaysInMonth / dim) * workedDays : avgDaysInMonth;
    return { y: mo.y, m: mo.m, income: base * factor, baseIncome: base, factor,
      days: dim, sickDays, vacDays, excludedDays, workedDays, coef };
  });
  const totalIncome = months.reduce((s, x) => s + x.income, 0);
  const totalCoef = months.reduce((s, x) => s + x.coef, 0);
  return { months, totalIncome, totalCoef, avgDaily: totalCoef > 0 ? totalIncome / totalCoef : 0 };
}

/* Отпускные по формуле — начисленная сумма (gross):
   { amount, days, avgDaily, months, totalIncome, totalCoef } или null */
export function vacationFormula(vacation, ctx, round = Math.round) {
  if (!vacation.start_date || !vacation.end_date || vacation.end_date < vacation.start_date) return null;
  const avg = averageDailyEarnings({ start: vacation.start_date, excludeVacationId: vacation.id, ...ctx });
  const days = daysInclusive(vacation.start_date, vacation.end_date);
  return { amount: round(avg.avgDaily * days), days, avgDaily: avg.avgDaily, months: avg.months,
    totalIncome: avg.totalIncome, totalCoef: avg.totalCoef };
}

/* Начисленная сумма, которая идёт в расчёт: своя или по формуле */
export function vacationPay(vacation, formula) {
  if (vacation.pay_manual) return Number(vacation.pay_amount) || 0;
  return formula ? formula.amount : 0;
}

/* Деление отпускных между выплатами: [{ period_id, days, amount }] */
export function splitVacationPay(vacation, amount, periods) {
  const total = daysInclusive(vacation.start_date, vacation.end_date);
  if (!total || !amount) return [];
  const parts_ = periods
    .map(p => ({ period_id: p.id, pay_date: p.pay_date,
      days: daysInWindow(vacation.start_date, vacation.end_date, p.window_start, p.window_end) }))
    .filter(x => x.days > 0)
    .sort((a, b) => (a.pay_date < b.pay_date ? -1 : a.pay_date > b.pay_date ? 1 : 0));
  const covered = parts_.reduce((s, p) => s + p.days, 0);
  let given = 0;
  parts_.forEach((x, i) => {
    // последняя часть получает остаток, только если весь отпуск попал в выплаты плана
    x.amount = i === parts_.length - 1 && covered === total
      ? amount - given
      : Math.round(amount * x.days / total);
    given += x.amount;
  });
  return parts_.map(({ period_id, days, amount: a }) => ({ period_id, days, amount: a }));
}
