/* Тесты движка доходов: календарь, оклад, налог, отпускные.
   Ожидаемые числа посчитаны отдельно, по формулам из документации. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar, payoutSchedule } from '../src/engine/calendar.js';
import { salaryForWindow, rateOn } from '../src/engine/salary.js';
import { taxOn, scaleForYear, taxForPayment, taxParts, grossFromNet, estimateMonthlyNet } from '../src/engine/tax.js';
import { averageDailyEarnings, vacationFormula, splitVacationPay } from '../src/engine/vacation.js';
import { computeIncome, generateYear } from '../src/engine/income.js';
import { createConfig } from '../src/core/config.js';
import { addDays, daysInclusive, addMonths } from '../src/engine/dates.js';

/* Праздники России, как в ref_calendar_days */
const RU = [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [1, 8], [2, 23], [3, 8], [5, 1], [5, 9], [6, 12], [11, 4]]
  .map(([month, day]) => ({ calendar_code: 'ru', rule: 'fixed', kind: 'holiday', day, month, title: '' }));

const cal = (extra = {}) => createCalendar({ refDays: RU, calendarCode: 'ru', ...extra });

const SLOTS_2027 = [
  { year: 2027, sort_order: 1, title: 'Аванс', pay_day: 20, month_offset: 0, window_from_day: 1, window_to_day: 15, shift_rule: 'back' },
  { year: 2027, sort_order: 2, title: 'Зарплата', pay_day: 5, month_offset: 1, window_from_day: 16, window_to_day: 31, shift_rule: 'back' },
];

const RATES = [{ id: 'r1', effective_from: '2027-01-01', amount: 230000, is_gross: true }];

const SCALES = [{ id: 'ru', title: 'НДФЛ', valid_from_year: 2025, cumulative: true }];
const BRACKETS = [
  { scale_id: 'ru', sort_order: 1, up_to: 2400000, rate: 13 },
  { scale_id: 'ru', sort_order: 2, up_to: 5000000, rate: 15 },
  { scale_id: 'ru', sort_order: 3, up_to: 20000000, rate: 18 },
  { scale_id: 'ru', sort_order: 4, up_to: 50000000, rate: 20 },
  { scale_id: 'ru', sort_order: 5, up_to: null, rate: 22 },
];

/* ------------------------------------------------------------------ даты */

test('даты: переходы через месяц и год, длина отрезков', () => {
  assert.equal(addDays('2027-12-31', 1), '2028-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.deepEqual(addMonths(2027, 12, 1), { y: 2028, m: 1 });
  assert.deepEqual(addMonths(2027, 1, -1), { y: 2026, m: 12 });
  assert.equal(daysInclusive('2027-08-10', '2027-08-17'), 8);
  assert.equal(daysInclusive('2027-08-17', '2027-08-10'), 0);
});

/* ------------------------------------------------------------------ календарь */

test('календарь: праздники, выходные, переносы, личные дни', () => {
  const c = cal({
    accountDays: [{ date: '2027-07-01', kind: 'holiday', title: 'Отгул' }],
  });
  assert.equal(c.isWorkingDay('2027-01-05'), false);            // вторник, новогодние
  assert.equal(c.day('2027-01-07').holiday, true);
  assert.equal(c.isWorkingDay('2027-01-09'), false);            // суббота
  assert.equal(c.isWorkingDay('2027-01-11'), true);
  assert.equal(c.isWorkingDay('2027-07-01'), false);            // личный праздник
  assert.equal(c.day('2027-07-01').source, 'account');

  const withTransfer = createCalendar({
    refDays: [...RU, { calendar_code: 'ru', rule: 'date', kind: 'workday', exact_date: '2027-01-09', title: 'Перенос' }],
  });
  assert.equal(withTransfer.isWorkingDay('2027-01-09'), true);  // рабочая суббота
  assert.equal(withTransfer.workingDaysInMonth(2027, 1), 16);

  // другой календарь не смешивается
  assert.equal(createCalendar({ refDays: RU, calendarCode: 'kz' }).isWorkingDay('2027-01-05'), true);
});

test('календарь: рабочие дни в месяцах 2027 года и ручная правка', () => {
  const c = cal();
  assert.equal(c.workingDaysInMonth(2027, 1), 15);
  assert.equal(c.workingDaysInMonth(2027, 3), 22);
  assert.equal(c.workingDaysInMonth(2027, 5), 21);
  assert.equal(c.workingDaysBetween('2027-03-01', '2027-03-15'), 10);

  const o = cal({ workingDayOverrides: [{ ym: '2027-03', working_days: 20 }, { ym: '2027-04', working_days: null }] });
  assert.equal(o.workingDaysInMonth(2027, 3), 20);
  assert.equal(o.calendarWorkingDaysInMonth(2027, 3), 22);
  assert.equal(o.hasOverride(2027, 4), false);
});

test('календарь: сдвиг даты выплаты с выходного', () => {
  const c = cal();
  assert.equal(c.shift('2027-02-20', 'back'), '2027-02-19');    // суббота → пятница
  assert.equal(c.shift('2027-02-20', 'forward'), '2027-02-22');
  assert.equal(c.shift('2027-02-20', 'none'), '2027-02-20');
  assert.equal(c.shift('2028-01-05', 'back'), '2027-12-31');    // новогодние → 31 декабря
  assert.equal(c.workingDayBefore('2027-08-02'), '2027-07-30'); // отпуск с понедельника
});

test('календарь: график выплат года по слотам', () => {
  const list = payoutSchedule(2027, [...SLOTS_2027, { ...SLOTS_2027[0], year: 2028 }], cal());
  assert.equal(list.length, 24);
  assert.deepEqual(list[0], {
    id: '2027-01-1', year: 2027, slot_order: 1, title: 'Аванс', pay_date: '2027-01-20',
    window_start: '2027-01-01', window_end: '2027-01-15',
    calc_mode: 'auto', income_net: 0, note: '', locked: false,
  });
  const janSalary = list.find(p => p.id === '2027-01-2');
  assert.equal(janSalary.pay_date, '2027-02-05');
  assert.equal(janSalary.window_end, '2027-01-31');
  assert.equal(list.find(p => p.id === '2027-02-2').window_end, '2027-02-28');   // 31 → конец февраля
  assert.equal(list.find(p => p.id === '2027-02-1').pay_date, '2027-02-19');     // 20.02 — суббота
  assert.equal(list.find(p => p.id === '2027-12-2').pay_date, '2027-12-31');     // 05.01.2028 — праздник
  // отсортировано по дате выплаты
  assert.ok(list.every((p, i) => i === 0 || list[i - 1].pay_date <= p.pay_date));
});

/* ------------------------------------------------------------------ оклад */

test('оклад: по рабочим дням половины месяца', () => {
  const r = salaryForWindow({ start: '2027-03-01', end: '2027-03-15', rates: RATES, calendar: cal() });
  assert.equal(r.gross, 104545);            // 230 000 × 10 / 22
  assert.equal(r.windowDays, 10);
  assert.equal(r.workedDays, 10);
  assert.deepEqual(r.months, [{ ym: '2027-03', monthWorkingDays: 22, windowDays: 10, workedDays: 10 }]);
});

test('оклад: повышение с середины периода считается по дням', () => {
  const rates = [...RATES, { id: 'r2', effective_from: '2027-06-10', amount: 250000, is_gross: true }];
  const r = salaryForWindow({ start: '2027-06-01', end: '2027-06-15', rates, calendar: cal() });
  assert.equal(r.gross, 118636);            // 7 дней × 230 000/22 + 4 дня × 250 000/22
  assert.equal(rateOn(rates, '2027-06-09').id, 'r1');
  assert.equal(rateOn(rates, '2027-06-10').id, 'r2');
  // порядок записей не важен — только дата
  assert.equal(rateOn([...rates].reverse(), '2027-07-01').id, 'r2');
});

test('оклад: дни отпуска не оплачиваются окладом', () => {
  const r = salaryForWindow({
    start: '2027-08-01', end: '2027-08-15', rates: RATES, calendar: cal(),
    absences: [['2027-08-10', '2027-08-17']],
  });
  assert.equal(r.gross, 62727);             // 6 отработанных из 10 рабочих, 22 в месяце
  assert.equal(r.absentDays, 4);
});

test('оклад: нет оклада — нет расчёта; оклад на руки не облагается', () => {
  assert.equal(salaryForWindow({ start: '2026-12-16', end: '2026-12-31', rates: RATES, calendar: cal() }), null);
  const net = salaryForWindow({
    start: '2027-03-01', end: '2027-03-15', calendar: cal(),
    rates: [{ id: 'n', effective_from: '2027-01-01', amount: 220000, is_gross: false }],
  });
  assert.equal(net.grossTaxable, 0);
  assert.equal(net.grossNet, 100000);
});

/* ------------------------------------------------------------------ налог */

test('налог: прогрессивная шкала в процентах', () => {
  assert.equal(taxOn(1000000, BRACKETS), 130000);
  assert.equal(taxOn(3000000, BRACKETS), 402000);   // 2,4 млн × 13 % + 0,6 млн × 15 %
  assert.equal(taxOn(0, BRACKETS), 0);
  // порядок ступеней в списке не важен
  assert.equal(taxOn(3000000, [...BRACKETS].reverse()), 402000);
});

test('налог: нарастающим итогом, выплата на границе ступени', () => {
  const s = scaleForYear(SCALES, BRACKETS, 2027);
  assert.equal(taxForPayment(100000, 0, s), 13000);
  assert.equal(taxForPayment(200000, 2300000, s), 13000 + 15000);  // 100 тыс. по 13 % и 100 тыс. по 15 %
  const flat = { scale: { ...SCALES[0], cumulative: false }, brackets: s.brackets };
  assert.equal(taxForPayment(200000, 2300000, flat), 26000);
});

test('налог: шкала по году, обратный пересчёт и оценка на месяц', () => {
  const scales = [...SCALES, { id: 'old', valid_from_year: 2020, cumulative: true }];
  const brackets = [...BRACKETS, { scale_id: 'old', sort_order: 1, up_to: null, rate: 13 }];
  assert.equal(scaleForYear(scales, brackets, 2024).scale.id, 'old');
  assert.equal(scaleForYear(scales, brackets, 2027).scale.id, 'ru');
  assert.equal(scaleForYear(scales, brackets, 2010), null);

  const s = scaleForYear(SCALES, BRACKETS, 2027);
  assert.ok(Math.abs(grossFromNet(87000, 0, s) - 100000) < 0.01);
  assert.equal(estimateMonthlyNet(230000, s), 199500);             // 2,76 млн в год → налог 366 000, в месяц 30 500
});

/* ------------------------------------------------------------------ отпускные */

test('отпускные: средний заработок и сумма по формуле', () => {
  const ctx = { monthIncome: () => 100000, rates: RATES, sickLeaves: [], avgDaysInMonth: 29.3 };
  const avg = averageDailyEarnings({ start: '2027-08-10', ...ctx });
  assert.equal(avg.months.length, 12);
  assert.deepEqual([avg.months[0].y, avg.months[0].m, avg.months[11].m], [2026, 8, 7]);
  assert.equal(vacationFormula({ start_date: '2027-08-10', end_date: '2027-08-16' }, ctx).amount, 23891);
});

test('отпускные: больничный уменьшает коэффициент месяца', () => {
  const ctx = {
    monthIncome: () => 100000, rates: RATES, avgDaysInMonth: 29.3,
    sickLeaves: [{ start_date: '2027-04-11', end_date: '2027-04-20' }],
  };
  const f = vacationFormula({ start_date: '2027-08-10', end_date: '2027-08-16' }, ctx);
  assert.equal(f.amount, 24573);
  assert.equal(f.months.find(m => m.m === 4).sickDays, 10);
});

test('отпускные: индексация применяется только к повышению «для всех»', () => {
  // повышение всем: заработок до него умножается на 253 000 / 230 000
  const all = [...RATES, { id: 'r2', effective_from: '2027-06-01', amount: 253000, is_gross: true, indexed: true }];
  const avg = averageDailyEarnings({ start: '2027-08-10', monthGross: () => 100000, rates: all, avgDaysInMonth: 29.3 });
  assert.ok(Math.abs(avg.months.find(m => m.y === 2027 && m.m === 5).factor - 1.1) < 1e-9);
  assert.equal(avg.months.find(m => m.y === 2027 && m.m === 6).factor, 1);

  // персональное повышение индексации не даёт
  const personal = [...RATES, { id: 'r2', effective_from: '2027-06-01', amount: 253000, is_gross: true, indexed: false }];
  const plain = averageDailyEarnings({ start: '2027-08-10', monthGross: () => 100000, rates: personal, avgDaysInMonth: 29.3 });
  assert.equal(plain.months.every(m => m.factor === 1), true);
});

test('отпускные: прошлый отпуск в расчётном периоде тоже делает месяц неполным', () => {
  const ctx = {
    monthIncome: () => 100000, rates: RATES, avgDaysInMonth: 29.3,
    sickLeaves: [],
    vacations: [
      { id: 'v-old', start_date: '2027-04-01', end_date: '2027-04-14' },   // 14 дней в апреле
      { id: 'v-new', start_date: '2027-08-10', end_date: '2027-08-23' },   // считаем его самого
    ],
  };
  const f = vacationFormula({ id: 'v-new', start_date: '2027-08-10', end_date: '2027-08-23' }, ctx);
  const april = f.months.find(m => m.m === 4 && m.y === 2027);
  assert.equal(april.vacDays, 14);
  assert.equal(april.workedDays, 16);
  assert.ok(Math.abs(april.coef - 29.3 / 30 * 16) < 1e-9);
  // свой собственный отпуск в коэффициент не попадает
  assert.equal(f.months.every(m => m.vacDays === 0 || m.m === 4), true);
});

test('доход: разовая выплата без налога не входит в нарастающий итог', async () => {
  const { computeIncome } = await import('../src/engine/income.js');
  const cfg = {
    get: k => ({ calendar_code: 'ru', base_currency: 'RUB', avg_days_in_month: 29.3 }[k]),
    list: n => (n === 'calendar_days' ? [] : []),
  };
  const base = {
    payout_slots: [], salary_rates: [], tax_scales: SCALES, tax_brackets: BRACKETS,
    vacations: [], sick_leaves: [], extra_incomes: [], income_history: [],
    account_calendar_days: [], working_day_overrides: [],
  };
  const period = extra => ({ id: 'p1', year: 2027, slot_order: null, pay_date: '2027-03-20',
    window_start: '2027-03-01', window_end: '2027-03-31', calc_mode: 'manual', income_net: 100000, locked: false, ...extra });

  const free = computeIncome({ income: { ...base, periods: [period({ taxable: false })] } }, cfg).periods[0];
  assert.equal(free.tax, 0);
  assert.equal(free.gross, 100000);          // начислено = на руки

  const taxed = computeIncome({ income: { ...base, periods: [period({ taxable: true })] } }, cfg).periods[0];
  assert.ok(taxed.tax > 0, 'с галочкой налог считается');
  assert.ok(taxed.gross > 100000);
});

test('налог: из каких ставок он сложился', () => {
  const s = scaleForYear(SCALES, BRACKETS, 2027);
  assert.deepEqual(taxParts(100000, 0, s), [{ rate: 13, amount: 13000 }]);
  assert.deepEqual(taxParts(200000, 2300000, s), [{ rate: 13, amount: 13000 }, { rate: 15, amount: 15000 }]);
  assert.deepEqual(taxParts(0, 0, s), []);
});

test('отпускные: деление между выплатами по дням расчётного периода', () => {
  const periods = [
    { id: 'a', pay_date: '2027-08-20', window_start: '2027-08-01', window_end: '2027-08-15' },
    { id: 'b', pay_date: '2027-09-05', window_start: '2027-08-16', window_end: '2027-08-31' },
  ];
  const split = splitVacationPay({ start_date: '2027-08-10', end_date: '2027-08-17' }, 80000, periods);
  assert.deepEqual(split.map(x => [x.period_id, x.days]), [['a', 6], ['b', 2]]);
  assert.equal(split.reduce((s, x) => s + x.amount, 0), 80000);      // копейки не теряются
});

/* Полный расчёт отпуска: gross → СДЗ → начислено → НДФЛ → на руки */
const VAC_CFG = {
  get: k => ({ calendar_code: 'ru', base_currency: 'RUB', avg_days_in_month: 29.3 }[k]),
  list: n => (n === 'calendar_days' ? RU : []),
};
const vacState = extra => ({
  income: {
    payout_slots: SLOTS_2027, salary_rates: RATES, tax_scales: SCALES, tax_brackets: BRACKETS,
    sick_leaves: [], extra_incomes: [], income_history: [], account_calendar_days: [], working_day_overrides: [],
    periods: [
      { id: 'p1', year: 2027, slot_order: 1, title: 'Аванс', pay_date: '2027-08-20', window_start: '2027-08-01', window_end: '2027-08-15', calc_mode: 'auto', income_net: 100000, locked: false },
      { id: 'p2', year: 2027, slot_order: 2, title: 'Зарплата', pay_date: '2027-09-03', window_start: '2027-08-16', window_end: '2027-08-31', calc_mode: 'auto', income_net: 100000, locked: false },
    ],
    ...extra,
  },
});

test('отпускные: своя сумма — это начислено, в план идёт остаток после налога', () => {
  const st = vacState({ vacations: [{ id: 'v', title: 'Отпуск', start_date: '2027-08-10', end_date: '2027-08-17', pay_manual: true, pay_amount: 100000 }] });
  const inc = computeIncome(st, VAC_CFG);
  const grossTotal = inc.periods.reduce((s, r) => s + r.vacationGross, 0);
  const netTotal = inc.periods.reduce((s, r) => s + r.vacationPay, 0);
  assert.equal(grossTotal, 100000, 'начислено — ровно введённая сумма');
  assert.ok(netTotal < grossTotal, 'на руки меньше на налог');
  assert.ok(Math.abs(netTotal - 87000) <= 2, `ожидали ~87 000 на руки, вышло ${netTotal}`);
});

test('отпускные: доход месяца для среднего берётся в начисленных суммах', () => {
  // расчётный период — август 2026 … июль 2027, заполняем историю в gross
  const history = [];
  for (let i = 0; i < 12; i++) {
    const m = 8 + i;
    history.push({ year: m > 12 ? 2027 : 2026, month: m > 12 ? m - 12 : m, amount: 230000 });
  }
  const st = vacState({ income_history: history,
    vacations: [{ id: 'v', title: 'Отпуск', start_date: '2027-08-10', end_date: '2027-08-16', pay_manual: false }] });
  const f = computeIncome(st, VAC_CFG).vacations[0].formula;
  assert.equal(f.months.length, 12);
  assert.ok(Math.abs(f.totalCoef - 12 * 29.3) < 1e-9);
  assert.ok(Math.abs(f.avgDaily - 2760000 / (12 * 29.3)) < 0.01, `СДЗ ${f.avgDaily}`);
  assert.equal(f.amount, Math.round(f.avgDaily * 7));      // начислено за 7 дней

  // налог удержится при выплате, в план уйдёт остаток
  const inc = computeIncome(st, VAC_CFG);
  const gross = inc.periods.reduce((s2, r) => s2 + r.vacationGross, 0);
  const net = inc.periods.reduce((s2, r) => s2 + r.vacationPay, 0);
  assert.equal(gross, f.amount);
  assert.ok(net < gross && net > gross * 0.8, `на руки ${net} из ${gross}`);
});

test('отпускные: подработка и подарок в средний заработок не идут, премия идёт', () => {
  const month = (m, kind, amount) => ({
    id: `x${m}${kind ?? ''}`, year: 2027, slot_order: kind ? null : 1, title: kind ?? 'Аванс',
    pay_date: `2027-${String(m).padStart(2, '0')}-20`, window_start: `2027-${String(m).padStart(2, '0')}-01`,
    window_end: `2027-${String(m).padStart(2, '0')}-28`, calc_mode: kind ? 'manual' : 'auto',
    manual_kind: kind, income_net: amount, locked: false, taxable: kind !== 'gift',
  });
  const build = extra => ({ income: {
    payout_slots: [], salary_rates: RATES, tax_scales: SCALES, tax_brackets: BRACKETS,
    sick_leaves: [], extra_incomes: [], income_history: [], account_calendar_days: [], working_day_overrides: [],
    periods: [month(3), ...extra],
    vacations: [{ id: 'v', title: 'Отпуск', start_date: '2027-08-10', end_date: '2027-08-16', pay_manual: false }],
  } });
  const baseOnly = computeIncome(build([]), VAC_CFG).vacations[0].formula.totalIncome;
  const withBonus = computeIncome(build([month(3, 'bonus', 50000)]), VAC_CFG).vacations[0].formula.totalIncome;
  const withSide = computeIncome(build([month(3, 'side_job', 50000)]), VAC_CFG).vacations[0].formula.totalIncome;
  const withGift = computeIncome(build([month(3, 'gift', 50000)]), VAC_CFG).vacations[0].formula.totalIncome;

  assert.ok(withBonus > baseOnly, 'премия увеличивает средний заработок');
  assert.equal(withSide, baseOnly, 'подработка в средний заработок не идёт');
  assert.equal(withGift, baseOnly, 'подарок в средний заработок не идёт');
});
