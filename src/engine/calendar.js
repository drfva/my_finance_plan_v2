/* ---------------------------------------------------------------------
   calendar.js — рабочие дни и даты выплат.

   Какой день рабочий, решается по слоям, от сильного к слабому:
     1. личные дни плана (account_calendar_days) — праздник или рабочий день;
     2. конкретные даты производственного календаря (ref_calendar_days, rule = 'date'):
        переносы выходных, рабочие субботы;
     3. ежегодные праздники календаря (rule = 'fixed', день и месяц);
     4. обычная неделя: суббота и воскресенье — выходные.

   Число рабочих дней в месяце можно исправить вручную (working_day_overrides):
   тогда оно используется как знаменатель в расчёте оклада.

   График выплат строится из слотов (payout_slots): за каждый месяц года — по
   одной выплате на слот. Расчётный период — дни window_from_day…window_to_day
   месяца начисления, дата выплаты — pay_day через month_offset месяцев,
   со сдвигом с выходного по shift_rule.
--------------------------------------------------------------------- */

import { iso, pad2, addDays, addMonths, dayOfWeek, clampDay, eachDay, daysInMonth } from './dates.js';

export function createCalendar({
  refDays = [],
  calendarCode = 'ru',
  accountDays = [],
  workingDayOverrides = [],
} = {}) {
  const fixed = new Map();      // 'ММ-ДД' → { kind, title }
  const exact = new Map();      // 'ГГГГ-ММ-ДД' → { kind, title }
  for (const r of refDays) {
    if (r.calendar_code !== calendarCode) continue;
    if (r.rule === 'fixed' && r.day && r.month) fixed.set(`${pad2(r.month)}-${pad2(r.day)}`, r);
    else if (r.rule === 'date' && r.exact_date) exact.set(r.exact_date, r);
  }
  const own = new Map(accountDays.map(r => [r.date, r]));
  const overrides = new Map(
    workingDayOverrides
      .filter(r => r.working_days !== null && r.working_days !== undefined && r.working_days !== '')
      .map(r => [r.ym, Number(r.working_days)]),
  );
  const monthCache = new Map();

  /* Что за день: { working, holiday, title, source } */
  function day(s) {
    const special = own.get(s) ?? exact.get(s) ?? fixed.get(s.slice(5));
    const source = own.has(s) ? 'account' : exact.has(s) ? 'calendar' : fixed.has(s.slice(5)) ? 'calendar' : 'week';
    if (special) {
      const holiday = special.kind === 'holiday';
      return { working: !holiday, holiday, title: special.title ?? '', source };
    }
    const dow = dayOfWeek(s);
    return { working: dow !== 0 && dow !== 6, holiday: false, title: '', source };
  }

  const isWorkingDay = s => day(s).working;

  function workingDaysBetween(from, to) {
    let n = 0;
    for (const d of eachDay(from, to)) if (isWorkingDay(d)) n++;
    return n;
  }

  /* Рабочих дней в месяце по календарю, без ручной правки */
  function calendarWorkingDaysInMonth(y, m) {
    const key = `${y}-${pad2(m)}`;
    if (!monthCache.has(key)) monthCache.set(key, workingDaysBetween(iso(y, m, 1), iso(y, m, daysInMonth(y, m))));
    return monthCache.get(key);
  }

  /* Рабочих дней в месяце: ручная правка важнее календаря */
  function workingDaysInMonth(y, m) {
    const key = `${y}-${pad2(m)}`;
    return overrides.has(key) ? overrides.get(key) : calendarWorkingDaysInMonth(y, m);
  }

  /* Сдвиг даты на рабочий день: back — на ближайший раньше, forward — позже, none — как есть */
  function shift(s, rule = 'back') {
    if (rule === 'none') return s;
    const step = rule === 'forward' ? 1 : -1;
    let d = s;
    for (let i = 0; i < 31; i++) {
      if (isWorkingDay(d)) return d;
      d = addDays(d, step);
    }
    return s;
  }

  /* Ближайший рабочий день строго до даты (отпускные платят накануне отпуска) */
  function workingDayBefore(s) {
    return shift(addDays(s, -1), 'back');
  }

  return {
    calendarCode,
    day, isWorkingDay, workingDaysBetween,
    workingDaysInMonth, calendarWorkingDaysInMonth,
    hasOverride: (y, m) => overrides.has(`${y}-${pad2(m)}`),
    shift, workingDayBefore,
  };
}

/* Выплаты года по слотам графика. Год выплаты — год начисления: зарплата за
   декабрь, которую платят в январе, относится к году декабря.
   Возвращает строки для periods без сумм (income_net заполняет движок дохода). */
export function payoutSchedule(year, slots, calendar) {
  const own = slots
    .filter(s => Number(s.year) === Number(year))
    .sort((a, b) => a.sort_order - b.sort_order);
  const out = [];
  for (let m = 1; m <= 12; m++) {
    for (const s of own) {
      const from = s.window_from_day ?? 1;
      const to = s.window_to_day ?? 31;
      const pay = addMonths(year, m, s.month_offset ?? 0);
      const planned = clampDay(pay.y, pay.m, s.pay_day);
      out.push({
        id: `${year}-${pad2(m)}-${s.sort_order}`,
        year,
        slot_order: s.sort_order,
        title: s.title ?? '',
        pay_date: calendar.shift(planned, s.shift_rule ?? 'back'),
        window_start: clampDay(year, m, from),
        window_end: clampDay(year, m, to),
        calc_mode: 'auto',
        income_net: 0,
        note: '',
        locked: false,
      });
    }
  }
  return out.sort((a, b) => (a.pay_date < b.pay_date ? -1 : a.pay_date > b.pay_date ? 1 : a.slot_order - b.slot_order));
}
