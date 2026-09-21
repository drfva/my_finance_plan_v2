/* ---------------------------------------------------------------------
   salary.js — оклад по отработанным дням.

   Каждый отработанный рабочий день расчётного периода стоит
       оклад, действующий в этот день ÷ рабочих дней в месяце этого дня.
   Дни отпусков и больничных не оплачиваются окладом: за отпуск платят
   отпускные (vacation.js). Повышение с середины месяца учитывается по дням.

   Оклад задаётся в salary_rates: с какой даты и сколько. is_gross = true —
   до налога (налог считает tax.js), false — уже на руки, налог не удерживается.
--------------------------------------------------------------------- */

import { eachDay, parts, overlap, daysInclusive } from './dates.js';

/* Оклад на дату: последняя запись с effective_from не позже даты (по дате, а не по порядку в списке) */
export function rateOn(rates, s) {
  let best = null;
  for (const r of rates) {
    if (!r.effective_from || r.effective_from > s) continue;
    if (!best || r.effective_from > best.effective_from
        || (r.effective_from === best.effective_from && String(r.id) > String(best.id))) best = r;
  }
  return best;
}

/* Отрезки отсутствия: отпуска и больничные с обеими датами */
export function absenceRanges(vacations = [], sickLeaves = []) {
  return [...vacations, ...sickLeaves]
    .filter(r => r.start_date && r.end_date && r.end_date >= r.start_date)
    .map(r => [r.start_date, r.end_date]);
}

const absent = (d, ranges) => ranges.some(([a, b]) => d >= a && d <= b);

/* Сколько начислено окладом за расчётный период.
   Результат: { gross, grossTaxable, grossNet, windowDays, workedDays, absentDays, months }
   или null, если оклада на период нет или в месяце нет рабочих дней. */
export function salaryForWindow({ start, end, rates, calendar, absences = [], round = Math.round }) {
  if (!start || !end || end < start) return null;
  let windowDays = 0;
  let workedDays = 0;
  let taxable = 0;
  let net = 0;
  let hasRate = false;
  const months = new Map();

  for (const d of eachDay(start, end)) {
    if (!calendar.isWorkingDay(d)) continue;
    windowDays++;
    const { y, m } = parts(d);
    const key = d.slice(0, 7);
    const monthWD = calendar.workingDaysInMonth(y, m);
    if (!months.has(key)) months.set(key, { ym: key, monthWorkingDays: monthWD, windowDays: 0, workedDays: 0 });
    const info = months.get(key);
    info.windowDays++;
    if (absent(d, absences)) continue;
    const rate = rateOn(rates, d);
    if (!rate || !(monthWD > 0)) continue;
    hasRate = true;
    workedDays++;
    info.workedDays++;
    const share = Number(rate.amount) / monthWD;
    if (rate.is_gross === false) net += share; else taxable += share;
  }

  if (!hasRate) return null;
  const grossTaxable = round(taxable);
  const grossNet = round(net);
  return {
    gross: grossTaxable + grossNet,
    grossTaxable,
    grossNet,
    windowDays,
    workedDays,
    absentDays: windowDays - workedDays,
    months: [...months.values()],
  };
}

/* Сколько календарных дней отрезка [from, to] попадает в расчётный период */
export function daysInWindow(from, to, windowStart, windowEnd) {
  const o = overlap(from, to, windowStart, windowEnd);
  return o ? daysInclusive(o.from, o.to) : 0;
}
