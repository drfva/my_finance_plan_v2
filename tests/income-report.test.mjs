import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIncomeReport } from '../src/engine/income-report.js';
import { renderIncomeReport } from '../src/ui/income-report.js';
import { createFormat } from '../src/core/format.js';

const fmt = createFormat({ locale: 'ru-RU', currency: 'RUB', currencies: [{ code: 'RUB', symbol: '₽' }] });
function fixture() {
  const state = { income: { payout_slots: [
    { year: 2026, sort_order: 2, title: 'Остаток оклада' }, { year: 2026, sort_order: 1, title: 'Первая часть' },
    { year: 2027, sort_order: 1, title: 'Одна выплата' },
  ], extra_incomes: [{ id: 'extra', date: '2026-02-01' }], sick_leaves: [{ id: 's', sfr_pay_date: '2026-03-02' }] } };
  const periods = [
    { period: { id: 'p1', year: 2026, slot_order: 1, title: 'Старый аванс', calc_mode: 'auto', pay_date: '2026-01-20', window_start: '2026-01-01' },
      salary: 87000, vacationPay: 8700, vacationGross: 10000, sickPay: 4350, sickGross: 5000,
      gross: 115000, tax: 14950, taxParts: [{ rate: 13, amount: 14950 }],
      vacations: [{ vacation_id: 'v', gross: 10000, net: 8700 }],
      sickParts: [{ leave_id: 's', payer: 'sfr', gross: 5000, net: 4350 }], extras: [{ extra_income_id: 'extra', amount: 500 }] },
    { period: { id: 'p2', year: 2026, slot_order: 2, calc_mode: 'auto', pay_date: '2026-02-05', window_start: '2026-01-16' },
      salary: 43500, gross: 50000, tax: 6500, taxParts: [{ rate: 13, amount: 6500 }] },
    { period: { id: 'gift', year: 2025, calc_mode: 'manual', pay_date: '2026-01-18', window_start: '2025-12-01' }, salary: 2000, gross: 2000, tax: 0 },
    { period: { id: 'bonus', year: 2026, calc_mode: 'manual', pay_date: '2026-01-30', window_start: '2026-01-01' },
      salary: 8700, gross: 10000, tax: 1300, taxParts: [{ rate: 13, amount: 1300 }] },
  ];
  const income = { periods, vacations: [{ vacation: { id: 'v' }, payDate: '2025-12-28' }] };
  return { state, income, year: 2026, fmt };
}

test('сводка доходов: настройки года задают порядок, названия и количество столбцов', () => {
  const ctx = fixture();
  let r = buildIncomeReport(ctx);
  assert.deepEqual(r.slots.map(s => s.title), ['Первая часть', 'Остаток оклада']);
  ctx.state.income.payout_slots[1].title = 'Новое название';
  assert.equal(buildIncomeReport(ctx).slots[0].title, 'Новое название');
  assert.deepEqual(buildIncomeReport({ ...ctx, year: 2027 }).slots.map(s => s.title), ['Одна выплата']);
  ctx.state.income.payout_slots.push({ year: 2027, sort_order: 3, title: 'Третья' }, { year: 2027, sort_order: 2, title: 'Вторая' });
  assert.deepEqual(buildIncomeReport({ ...ctx, year: 2027 }).slots.map(s => s.title), ['Одна выплата', 'Вторая', 'Третья']);
});

test('сводка доходов: зарплата, отпускные и больничный считаются один раз; разовые идут по дате', () => {
  const ctx = fixture(), r = buildIncomeReport(ctx), jan = r.months[0];
  assert.equal(jan.slots.get('1'), 100050);
  assert.equal(jan.slots.get('2'), 43500);
  assert.equal(jan.automatic.net, 143550);
  assert.equal(jan.automatic.gross, 165000);
  assert.equal(jan.automatic.tax, 21450);
  assert.equal(jan.oneOff.net, 10700);
  assert.equal(jan.oneOff.tax, 1300);
  assert.equal(r.months[1].oneOff.net, 500);
  assert.equal(r.totals.automatic.net + r.totals.oneOff.net, 154750);
  assert.equal(r.totals.slots.get('1') + r.totals.slots.get('2'), r.totals.automatic.net);
});

test('сводка доходов: реальные даты справки не зависят от распределения и могут пересекать годы', () => {
  const ctx = fixture(), r = buildIncomeReport(ctx);
  assert.equal(r.months[0].sick.net, 0);
  assert.equal(r.months[2].sick.net, 4350);
  assert.equal(r.totals.vacation.net, 0);
  assert.equal(buildIncomeReport({ ...ctx, year: 2025 }).totals.vacation.net, 8700);
  ctx.state.income.sick_leaves[0].sfr_pay_date = null;
  let edited = buildIncomeReport(ctx);
  assert.equal(edited.totals.sick.net, 0);
  assert.equal(edited.months[0].missingSickDates, 4350);
  ctx.state.income.sick_leaves[0].sfr_pay_date = '2026-04-01';
  edited = buildIncomeReport(ctx);
  assert.equal(edited.months[3].sick.net, 4350);
  assert.equal(edited.totals.automatic.net, r.totals.automatic.net);
});

test('сводка доходов: изменения расчёта и налогов сразу меняют статистику и годовой итог', () => {
  const ctx = fixture();
  ctx.income.periods[0].salary = 1000;
  ctx.income.periods[0].gross = 2000;
  ctx.income.periods[0].tax = 200;
  ctx.income.periods[0].taxParts = [{ rate: 15, amount: 200 }];
  const r = buildIncomeReport(ctx);
  assert.equal(r.months[0].automatic.net, 57550);
  assert.equal(r.totals.automatic.gross, 52000);
  assert.equal(r.totals.automatic.tax, 6700);
  assert.equal(r.totals.automatic.rates.get(15), 200);
});

test('таблица доходов: порядок столбцов, подсказки в месяце/году, без лишних колонок', () => {
  const ctx = fixture(), html = renderIncomeReport(ctx);
  const header = html.match(/<thead>([\s\S]*?)<\/thead>/)[1];
  assert.deepEqual([...header.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(m => m[1]),
    ['Месяц', 'Первая часть', 'Остаток оклада', 'Всего', 'Разовые выплаты', 'Общий доход']);
  assert.match(html, /popovertarget="income-info-2026-2026-01-automatic"/);
  assert.match(html, /popovertarget="income-info-2026-2026-01-oneOff"/);
  assert.doesNotMatch(html, /popovertarget="income-info-2026-2026-02-oneOff"/);
  assert.match(html, /popovertarget="income-info-2026-year-oneOff"/);
  assert.match(html, /<dt>Начислено до НДФЛ<\/dt>/);
  assert.match(html, /<dt>Ставки НДФЛ<\/dt>/);
});
