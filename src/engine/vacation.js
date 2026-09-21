/* ---------------------------------------------------------------------
   vacation.js — отпускные.

   Средний дневной заработок:
     расчётный период   = 12 календарных месяцев до месяца начала отпуска;
     доход месяца       = monthIncome(y, m) — его даёт income.js (выплаты или
                          история доходов, отпускные в доход не входят);
     индексация         = если оклад на дату начала отпуска выше оклада на конец
                          месяца, доход месяца × (новый оклад / старый);
     коэффициент месяца = avg_days_in_month (29,3), а при больничных
                          avg_days_in_month / дней в месяце × (дней в месяце − дней больничного);
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

function sickDaysInMonth(y, m, sickLeaves) {
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = monthEnd(y, m);
  let days = 0;
  for (const s of sickLeaves) {
    if (!s.start_date || !s.end_date) continue;
    const o = overlap(s.start_date, s.end_date, from, to);
    if (o) days += daysInclusive(o.from, o.to);
  }
  return Math.min(days, daysInMonth(y, m));
}

function raiseFactor(y, m, start, rates) {
  const atMonth = rateOn(rates, monthEnd(y, m));
  const atVacation = rateOn(rates, start);
  if (atMonth && atVacation && Number(atMonth.amount) > 0 && Number(atVacation.amount) > Number(atMonth.amount)) {
    return Number(atVacation.amount) / Number(atMonth.amount);
  }
  return 1;
}

/* Средний дневной заработок на дату начала отпуска */
export function averageDailyEarnings({ start, monthIncome, rates = [], sickLeaves = [], avgDaysInMonth = 29.3 }) {
  const { y, m } = parts(start);
  const months = monthsBefore(y, m, 12).map(mo => {
    const base = Number(monthIncome(mo.y, mo.m)) || 0;
    const factor = raiseFactor(mo.y, mo.m, start, rates);
    const sickDays = sickDaysInMonth(mo.y, mo.m, sickLeaves);
    const dim = daysInMonth(mo.y, mo.m);
    const coef = sickDays > 0 ? (avgDaysInMonth / dim) * (dim - sickDays) : avgDaysInMonth;
    return { y: mo.y, m: mo.m, income: base * factor, baseIncome: base, factor, sickDays, coef };
  });
  const totalIncome = months.reduce((s, x) => s + x.income, 0);
  const totalCoef = months.reduce((s, x) => s + x.coef, 0);
  return { months, totalIncome, totalCoef, avgDaily: totalCoef > 0 ? totalIncome / totalCoef : 0 };
}

/* Отпускные по формуле: { amount, days, avgDaily, months } или null */
export function vacationFormula(vacation, ctx, round = Math.round) {
  if (!vacation.start_date || !vacation.end_date || vacation.end_date < vacation.start_date) return null;
  const avg = averageDailyEarnings({ start: vacation.start_date, ...ctx });
  const days = daysInclusive(vacation.start_date, vacation.end_date);
  return { amount: round(avg.avgDaily * days), days, avgDaily: avg.avgDaily, months: avg.months };
}

/* Сумма, которая идёт в план */
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
