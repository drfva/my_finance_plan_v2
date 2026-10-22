/* Тесты этапа 4: расходы, долги, накопления, конвейер распределения. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planExpenses, inSeason } from '../src/engine/expenses.js';
import { buildInstallmentSchedule, installmentsByPeriod, newCardState, cardApplyOp, cardApplyPayment } from '../src/engine/debts.js';
import { createTracker, cycleDates, giftAmountForYear, syncGenerated, milestonesOf } from '../src/engine/savings.js';
import { simulate, freezePeriods, goalBalanceAt, goalProgressAt, snapshotGoalCompletion, reservePaceSuggestion, proposeRedistribution, cardForecast, goalNeedAt, forecastBeyondPlan } from '../src/engine/allocation.js';
import { createFx } from '../src/engine/fx.js';
import { createConfig } from '../src/core/config.js';

const UNITS = [{ code: 'day', days: 1 }, { code: 'week', days: 7 }, { code: 'month', days: null }, { code: 'year', days: null }];

/* Две выплаты в месяц: аванс за 1–15, зарплата за 16–конец */
function payouts(months, { year = 2027, net = 100000 } = {}) {
  const out = [];
  for (const m of months) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
    out.push({ id: `${year}-${mm}-1`, year, slot_order: 1, pay_date: `${year}-${mm}-20`, window_start: `${year}-${mm}-01`, window_end: `${year}-${mm}-15`, calc_mode: 'auto', income_net: net, locked: false });
    out.push({ id: `${year}-${mm}-2`, year, slot_order: 2, pay_date: `${next}-05`, window_start: `${year}-${mm}-16`, window_end: `${year}-${mm}-${last}`, calc_mode: 'auto', income_net: net, locked: false });
  }
  return out.sort((a, b) => (a.pay_date < b.pay_date ? -1 : 1));
}
const SLOTS = [
  { year: 2027, sort_order: 1, window_from_day: 1, window_to_day: 15 },
  { year: 2027, sort_order: 2, window_from_day: 16, window_to_day: 31 },
];

/* ------------------------------------------------------------------ расходы */

test('расходы: сумма месяца поровну и по длине периода, копейки не теряются', () => {
  const periods = payouts([3]);
  const inc = new Map(periods.map(p => [p.id, 100000]));
  const r = planExpenses({
    periods, slots: SLOTS, incomeById: inc,
    categories: [
      { id: 'even', mode: 'fixed_month', monthly_amount: 10001, split_mode: 'even' },
      { id: 'days', mode: 'fixed_month', monthly_amount: 31000, split_mode: 'by_days' },
    ],
  });
  const a = r.byPeriod.get('2027-03-1').categories;
  const b = r.byPeriod.get('2027-03-2').categories;
  assert.equal(a[0].amount + b[0].amount, 10001);
  assert.deepEqual([a[0].amount, b[0].amount], [5001, 5000]);
  assert.deepEqual([a[1].amount, b[1].amount], [15000, 16000]);   // 15 и 16 дней марта
});

test('расходы: выплата не берёт на себя долю отсутствующей выплаты графика', () => {
  // в плане только зарплата за март — аванс был до начала плана
  const periods = payouts([3]).filter(p => p.slot_order === 2);
  const r = planExpenses({ periods, slots: SLOTS, incomeById: new Map(),
    categories: [{ id: 'c', mode: 'fixed_month', monthly_amount: 10000, split_mode: 'even' }] });
  assert.equal(r.byPeriod.get('2027-03-2').total, 5000);
});

test('расходы: разовая ручная выплата не делит сумму месяца', () => {
  const periods = [...payouts([3]), { id: 'bonus', year: 2027, slot_order: null, pay_date: '2027-03-25', window_start: '2027-03-01', window_end: '2027-03-31', calc_mode: 'manual', income_net: 50000 }];
  const r = planExpenses({ periods, slots: SLOTS, incomeById: new Map(),
    categories: [{ id: 'c', mode: 'fixed_month', monthly_amount: 10000, split_mode: 'even' }] });
  assert.equal(r.byPeriod.get('bonus').total, 0);
  assert.equal(r.byPeriod.get('2027-03-1').total + r.byPeriod.get('2027-03-2').total, 10000);
});

test('расходы: сезон категории и статей, в том числе через Новый год', () => {
  assert.equal(inSeason('2027-01-10', '12-01', '03-20'), true);
  assert.equal(inSeason('2027-04-10', '12-01', '03-20'), false);
  const periods = [...payouts([3]), ...payouts([4])];
  const r = planExpenses({ periods, slots: SLOTS, incomeById: new Map(),
    categories: [
      { id: 'ski', mode: 'fixed_month', monthly_amount: 12000, split_mode: 'even', season_from: '12-01', season_to: '03-20' },
      { id: 'health', mode: 'fixed_month', monthly_amount: 0, split_mode: 'even' },
    ],
    items: [
      { id: 'i1', category_id: 'health', amount: 3000 },
      { id: 'i2', category_id: 'health', amount: 8000, season_from: '10-01', season_to: '03-31' },
    ],
  });
  const cat = (pid, cid) => r.byPeriod.get(pid).categories.find(c => c.category_id === cid).amount;
  assert.equal(cat('2027-03-1', 'ski'), 6000);   // 20.03 — ещё сезон
  assert.equal(cat('2027-03-2', 'ski'), 0);      // выплата 05.04 — сезон кончился
  assert.equal(cat('2027-03-1', 'health'), 5500);
  assert.equal(cat('2027-04-1', 'health'), 1500);
});

test('расходы: доля категории в общих расходах, а не заданный процент', () => {
  const periods = payouts([3]);
  const inc = new Map([['2027-03-1', 1000], ['2027-03-2', 1000]]);
  const cats = [
    { id: 'life', mode: 'percent_income', monthly_amount: 10000 },   // 10 % от 100 000
    { id: 'rest', mode: 'fixed_month', monthly_amount: 90000, split_mode: 'even' },
  ];
  const r = planExpenses({ periods, slots: SLOTS, incomeById: inc, categories: cats });
  const first = r.byPeriod.get('2027-03-1').categories.find(c => c.category_id === 'life');
  assert.equal(first.share, 10);
  assert.equal(first.amount, 100);                       // 10 % от выплаты 1 000

  // сезон меняет знаменатель: вне сезона категория в долях не участвует
  const seasonal = planExpenses({ periods, slots: SLOTS, incomeById: inc,
    categories: [...cats, { id: 'winter', mode: 'percent_income', monthly_amount: 100000, season_from: '12-01', season_to: '02-28' }] });
  const inMarch = seasonal.byPeriod.get('2027-03-1').categories.find(c => c.category_id === 'life');
  assert.equal(inMarch.share, 10);
  const off = seasonal.byPeriod.get('2027-03-1').categories.find(c => c.category_id === 'winter');
  assert.equal(off.amount, 0);
});

test('расходы: процентная категория сверяется с планом месяца, ручная правка учитывается', () => {
  const periods = payouts([3]);
  const inc = new Map([['2027-03-1', 60000], ['2027-03-2', 80000]]);
  const r = planExpenses({ periods, slots: SLOTS, incomeById: inc,
    categories: [{ id: 'fun', mode: 'percent_income', monthly_amount: 20000 },
      { id: 'rest', mode: 'fixed_month', monthly_amount: 180000, split_mode: 'even' }],
    overrides: [{ period_id: '2027-03-2', category_id: 'fun', amount: 5000 }] });
  const first = r.byPeriod.get('2027-03-1').categories.find(c => c.category_id === 'fun');
  assert.equal(first.share, 10);
  assert.equal(first.amount, 6000);                      // 10 % от 60 000
  const second = r.byPeriod.get('2027-03-2').categories.find(c => c.category_id === 'fun');
  assert.deepEqual([second.planned, second.amount, second.overridden], [8000, 5000, true]);
  const check = r.monthChecks[0];
  assert.equal(check.collected, 11000);
  assert.equal(check.shortfall, 9000);
  assert.ok(Math.abs(check.missingPercent - 10 * (20000 / 11000 - 1)) < 1e-9);
});

test('рассрочка: график по неделям и месяцам, конец месяца', () => {
  const weekly = buildInstallmentSchedule({ id: 'i', total: 1000, parts: 3, every_n: 2, period_unit: 'week', first_date: '2027-03-03' }, UNITS);
  assert.deepEqual(weekly.map(p => [p.pay_date, p.amount]), [['2027-03-03', 334], ['2027-03-17', 333], ['2027-03-31', 333]]);
  const monthly = buildInstallmentSchedule({ id: 'i', total: 900, parts: 3, every_n: 1, period_unit: 'month', first_date: '2027-01-31' }, UNITS);
  assert.deepEqual(monthly.map(p => p.pay_date), ['2027-01-31', '2027-02-28', '2027-03-31']);
});

test('рассрочка: платёж из последней выплаты не позже его даты', () => {
  const periods = payouts([3]);
  const r = installmentsByPeriod([{ id: 'i', title: 'Телефон' }], [
    { installment_id: 'i', pay_date: '2027-03-22', amount: 100 },
    { installment_id: 'i', pay_date: '2027-03-22', amount: 50 },
    { installment_id: 'i', pay_date: '2027-03-01', amount: 70 },
  ], periods);
  assert.deepEqual(r.byPeriod.get('2027-03-1'), [{ date: '2027-03-22', amount: 150, installments: ['i'] }]);
  assert.equal(r.outside.length, 1);
});

test('карта: льготный период открывается тратой и закрывается полным погашением', () => {
  const cs = newCardState();
  const cycles = [];
  const card = { grace_days: 55 };
  cardApplyOp(cs, card, { op_date: '2027-02-10', amount: 60000, kind: 'spend' }, cycles);
  cardApplyOp(cs, card, { op_date: '2027-03-01', amount: 15000, kind: 'spend' }, cycles);
  assert.deepEqual([cs.debt, cs.deadline], [75000, '2027-04-06']);
  cardApplyPayment(cs, 74999.6, '2027-04-01', cycles);
  assert.deepEqual([cs.debt, cs.deadline], [0, null]);
  assert.deepEqual(cycles, [{ start: '2027-02-10', deadline: '2027-04-06', closed: '2027-04-01' }]);
});

/* ------------------------------------------------------------------ накопления */

test('копилка: этап держится, только пока денег хватает на его срок', () => {
  const goals = [{ id: 'g', title: 'Лечение' }];
  const milestones = [{ id: 'a', goal_id: 'g', target: 10000, deadline: '2027-10-05' }];

  // пополнили 01.10, этап закрылся; трата 04.10 — до срока, на 05.10 денег не хватит
  const t = createTracker({ goals, milestones });
  t.apply({ goal_id: 'g', date: '2027-10-01', amount: 10000, kind: 'transfer_in' });
  assert.equal(t.milestoneDates().g[0], '2027-10-01');
  t.apply({ goal_id: 'g', date: '2027-10-04', amount: 5000, kind: 'spend' });
  assert.equal(t.milestoneDates().g[0], null, 'этап снова открыт');
  assert.deepEqual(t.phase('g'), { idx: 0, saved: 5000 });
  assert.equal(t.balance('g'), 5000);

  // тот же этап со сроком 03.10: к сроку деньги были, трата 04.10 уже после него
  const past = [{ id: 'a', goal_id: 'g', target: 10000, deadline: '2027-10-03' }];
  const t2 = createTracker({ goals, milestones: past });
  t2.apply({ goal_id: 'g', date: '2027-10-01', amount: 10000, kind: 'transfer_in' });
  t2.apply({ goal_id: 'g', date: '2027-10-04', amount: 5000, kind: 'spend' });
  assert.equal(t2.milestoneDates().g[0], '2027-10-01', 'срок прошёл — этап засчитан');
  assert.equal(t2.milestoneFunded().g[0], 5000);
  assert.equal(t2.balance('g'), 5000);

  // трата задним числом, до срока этапа, — на 03.10 денег уже не хватало
  const t3 = createTracker({ goals, milestones: past });
  t3.apply({ goal_id: 'g', date: '2027-10-01', amount: 10000, kind: 'transfer_in' });
  t3.apply({ goal_id: 'g', date: '2027-10-02', amount: 5000, kind: 'spend' });
  assert.equal(t3.milestoneDates().g[0], null);
  assert.equal(t3.balance('g'), 5000);
});

test('копилка: вид оттока роли не играет, важна только дата', () => {
  const goals = [{ id: 'g', title: 'Лечение' }];
  const milestones = [
    { id: 'a', goal_id: 'g', target: 100, deadline: '2027-04-01' },
    { id: 'b', goal_id: 'g', target: 100, deadline: '2027-08-01' },
  ];
  // перевод в другую копилку и трата откатывают этап одинаково
  for (const kind of ['transfer_out', 'spend']) {
    const t = createTracker({ goals, milestones });
    t.apply({ goal_id: 'g', date: '2027-03-01', amount: 120, kind: 'transfer_in' });
    assert.equal(t.milestoneDates().g[0], '2027-03-01');
    t.apply({ goal_id: 'g', date: '2027-03-25', amount: 110, kind });
    assert.equal(t.milestoneDates().g[0], null, kind);
    assert.equal(t.balance('g'), 10);
  }

  // отток сначала тратит накопленное на прошедший этап, потом прогресс текущего
  const t2 = createTracker({ goals, milestones });
  t2.apply({ goal_id: 'g', date: '2027-03-01', amount: 150, kind: 'transfer_in' });
  assert.deepEqual(t2.phase('g'), { idx: 1, saved: 50 });
  t2.apply({ goal_id: 'g', date: '2027-04-10', amount: 120, kind: 'spend' });
  assert.equal(t2.milestoneDates().g[0], '2027-03-01', 'срок первого этапа прошёл');
  assert.equal(t2.milestoneFunded().g[0], 0, 'его 100 потрачены первыми');
  assert.deepEqual(t2.phase('g'), { idx: 1, saved: 30 }, 'из прогресса ушло только 20');
  assert.equal(t2.balance('g'), 30);

  // «сегодня» тоже делает этап прошедшим: трата до срока его уже не откатывает
  const t3 = createTracker({ goals, milestones, today: '2027-04-20' });
  t3.apply({ goal_id: 'g', date: '2027-03-01', amount: 120, kind: 'transfer_in' });
  t3.apply({ goal_id: 'g', date: '2027-03-25', amount: 110, kind: 'spend' });
  assert.equal(t3.milestoneDates().g[0], '2027-03-01', 'срок 01.04 уже позади');
  assert.equal(t3.milestoneFunded().g[0], 0);
  assert.equal(t3.balance('g'), 10);
});

test('копилка: трата тратит накопленное на прошедшие этапы, будущие пересчитываются', () => {
  const goals = [{ id: 'g', title: 'Лечение' }];
  const ms = (d2, d3) => [
    { id: 'm1', goal_id: 'g', title: 'Анализы+КТ', target: 20845, deadline: '2026-08-25' },
    { id: 'm2', goal_id: 'g', title: 'Химия', target: 42853, deadline: d2 },
    { id: 'm3', goal_id: 'g', title: 'Химия+КТ', target: 25000, deadline: d3 },
    { id: 'm4', goal_id: 'g', title: 'Операция', target: 40000, deadline: '2027-02-01' },
  ];
  const events = [
    { date: '2026-08-20', amount: 20845, kind: 'deposit' },
    { date: '2026-08-30', amount: 20845, kind: 'spend' },      // после срока m1 — этап засчитан
    { date: '2026-09-04', amount: 42853, kind: 'deposit' },
    { date: '2026-09-18', amount: 61000, kind: 'deposit' },
  ];
  const fill = t => { for (const e of events) t.apply({ goal_id: 'g', ...e }); return t; };

  // сроки первых трёх этапов позади: трата берёт накопленное на них, с самого
  // раннего, и ничего не откатывает — пересчитывается только будущая «Операция»
  const t = fill(createTracker({ goals, milestones: ms('2026-09-05', '2026-09-20'), today: '2026-09-23' }));
  assert.deepEqual(t.phase('g'), { idx: 3, saved: 36000 });
  t.apply({ goal_id: 'g', date: '2026-09-19', amount: 42853, kind: 'spend' });
  assert.equal(t.balance('g'), 61000);
  assert.deepEqual(t.milestoneFunded().g, [0, 0, 25000, null], 'потрачено накопленное на «Химию»');
  assert.deepEqual(t.phase('g'), { idx: 3, saved: 36000 }, 'прогресс «Операции» не тронут');

  // сроки «Химии» и «Химии+КТ» ещё впереди: трогать нечего, трата съедает прогресс
  // «Операции» и откатывает последний закрытый этап — на его дату денег не хватит
  const t2 = fill(createTracker({ goals, milestones: ms('2026-10-10', '2026-11-21'), today: '2026-09-23' }));
  t2.apply({ goal_id: 'g', date: '2026-09-19', amount: 42853, kind: 'spend' });
  assert.equal(t2.milestoneDates().g[2], null);
  assert.deepEqual(t2.phase('g'), { idx: 2, saved: 18147 });

  // баланс копилки всегда равен резервам закрытых этапов плюс прогресс текущего
  // (в минусе и то и другое ноль, а минус закрывает первое же пополнение)
  const t3 = createTracker({ goals, milestones: ms('2026-10-10', '2026-11-21'), today: '2026-09-23' });
  t3.apply({ goal_id: 'g', date: '2026-08-20', amount: 20845, kind: 'deposit' });
  t3.apply({ goal_id: 'g', date: '2026-08-30', amount: 30000, kind: 'spend' });
  assert.equal(t3.balance('g'), -9155);
  assert.deepEqual(t3.phase('g'), { idx: 1, saved: 0 }, 'первый этап накоплен к сроку и потрачен');
  t3.apply({ goal_id: 'g', date: '2026-09-04', amount: 10000, kind: 'deposit' });
  assert.equal(t3.balance('g'), 845);
  assert.deepEqual(t3.phase('g'), { idx: 1, saved: 845 }, 'пополнение сначала закрыло минус');

  for (const tr of [t, t2, t3]) {
    const sum = tr.milestoneFunded().g.reduce((acc, x) => acc + (x ?? 0), 0) + tr.phase('g').saved;
    assert.equal(Math.round(sum), Math.round(Math.max(0, tr.balance('g'))));
  }
});

test('цикл: даты повторов, пропуски и ручная правка', () => {
  assert.deepEqual(cycleDates({ start_date: '2027-01-31', every_n: 1, period_unit: 'month', repeats: 3 }, null, UNITS),
    ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.deepEqual(cycleDates({ start_date: '2027-09-01', every_n: 1, period_unit: 'year' }, '2029-12-31', UNITS),
    ['2027-09-01', '2028-09-01', '2029-09-01']);

  const savings = {
    goals: [{ id: 'g', title: 'Оплата зала' }],
    goal_cycles: [{ id: 'c', goal_id: 'g', title: 'Зал', amount: 18000, every_n: 1, period_unit: 'year', start_date: '2027-09-01', auto_spend: true }],
    goal_cycle_skips: [{ cycle_id: 'c', occurrence_key: '2028-09-01' }],
    goal_milestones: [
      { id: 'manual', goal_id: 'g', title: 'Своё', target: 1, deadline: null, source: 'manual' },
      { id: 'cyc:c:2029-09-01', goal_id: 'g', title: 'Зал подорожал', target: 20000, deadline: '2029-09-01', source: 'cycle', occurrence_key: '2029-09-01', user_edited: true },
      { id: 'cyc:c:2030-09-01', goal_id: 'g', title: 'Старое', target: 1, deadline: '2030-09-01', source: 'cycle', occurrence_key: '2030-09-01', user_edited: false },
    ],
    goal_transactions: [],
  };
  const r = syncGenerated({ savings, until: '2029-12-31', units: UNITS });
  assert.deepEqual(r.goal_milestones.map(m => [m.id, m.target]), [
    ['cyc:c:2027-09-01', 18000],
    ['cyc:c:2029-09-01', 20000],   // правка пользователя сохранилась
    ['manual', 1],
  ]);                               // 2028 пропущен, 2030 за пределами плана удалён
  assert.deepEqual(r.goal_transactions.map(t => [t.id, t.milestone_id]), [['cyc:c:2027-09-01:spend', 'cyc:c:2027-09-01']]);
  assert.equal(r.changed, true);
  // повторный запуск ничего не меняет
  const again = syncGenerated({ savings: { ...savings, ...r }, until: '2029-12-31', units: UNITS });
  assert.equal(again.changed, false);
});

test('подарки: сумма переходит на следующий год, прошедшие даты не планируются', () => {
  const amounts = [{ event_id: 'mom', year: 2027, amount: 10000 }, { event_id: 'mom', year: 2029, amount: 15000 }];
  assert.equal(giftAmountForYear('mom', amounts, 2028), 10000);
  assert.equal(giftAmountForYear('mom', amounts, 2030), 15000);
  assert.equal(giftAmountForYear('mom', amounts, 2026), 10000);

  const r = syncGenerated({
    savings: { goals: [{ id: 'gifts', title: 'Подарки', kind_code: 'gifts' }], goal_milestones: [], goal_transactions: [] },
    gifts: {
      gift_events: [
        { id: 'mom', title: 'ДР мамы', day: 15, month: 3, repeat_kind: 'yearly' },
        { id: 'wed', title: 'Свадьба Оли', day: 20, month: 6, repeat_kind: 'once', base_year: 2028 },
      ],
      gift_event_amounts: amounts,
    },
    years: [2027, 2028], today: '2027-04-01',
  });
  assert.deepEqual(r.goal_milestones.map(m => [m.title, m.target, m.deadline]), [
    ['ДР мамы 2028', 10000, '2028-03-15'],       // 15.03.2027 уже прошло
    ['Свадьба Оли 2028', 0, '2028-06-20'],
  ]);
});

test('валюта: курс на дату, обратная пара, нет курса — null', () => {
  const fx = createFx([
    { base_code: 'RUB', quote_code: 'USD', rate_date: '2027-01-01', rate: 90 },
    { base_code: 'RUB', quote_code: 'USD', rate_date: '2027-06-01', rate: 100 },
    { base_code: 'EUR', quote_code: 'RUB', rate_date: '2027-01-01', rate: 0.01 },
  ], 'RUB');
  assert.equal(fx.toBase(10, 'USD', '2027-03-01'), 900);
  assert.equal(fx.toBase(10, 'USD', '2027-07-01'), 1000);
  assert.equal(fx.toBase(10, 'USD', '2026-01-01'), 900);
  assert.equal(fx.toBase(1, 'EUR', '2027-03-01'), 100);
  assert.equal(fx.toBase(1, 'GBP', '2027-03-01'), null);
  assert.equal(fx.fromBase(1000, 'USD', '2027-07-01'), 10);
});

/* ------------------------------------------------------------------ конвейер */

const REF = {
  setting_defaults: [
    ['base_currency', 'RUB'], ['calendar_code', 'ru'], ['avg_days_in_month', 29.3], ['rounding', 1],
    ['planned_spend_window_days', 45], ['locale', 'ru-RU', 'user'],
  ].map(([key, value, scope = 'account']) => ({ key, value, scope })),
  calendar_days: [],
  allocation_stages: ['categories', 'gifts', 'installments', 'credits', 'buckets', 'reserves']
    .map((code, i) => ({ code, title: code, default_priority: i + 1 })),
  goal_kinds: [{ code: 'bucket', stage_code: 'buckets' }, { code: 'reserve', stage_code: 'reserves' }, { code: 'gifts', stage_code: 'gifts' }],
  currencies: [{ code: 'RUB', symbol: '₽' }, { code: 'USD', symbol: '$' }],
};

function plan({ periods = payouts([1, 2, 3, 4, 5, 6]), goals = [], milestones = [], txs = [], rules = [], categories = [], cards = [], ops = [], fx = [], overrides = [] } = {}) {
  return {
    ref: REF, user: { settings: {} }, account: { id: 'a', can_edit: true },
    settings: { account_settings: {}, allocation_rules: rules, fx_rates: fx },
    income: { payout_slots: SLOTS, periods, salary_rates: [], tax_scales: [], tax_brackets: [], vacations: [], sick_leaves: [], extra_incomes: [], income_history: [] },
    expenses: { expense_categories: categories, expense_items: [], expense_period_overrides: [] },
    debts: { credit_cards: cards, credit_card_ops: ops, credit_payment_overrides: [], installments: [], installment_payments: [] },
    savings: { goals, goal_milestones: milestones, goal_transactions: txs, savings_period_overrides: overrides },
  };
}
const run = st => simulate(st, createConfig(st));
const goal = (id, extra = {}) => ({ id, title: id, kind_code: 'bucket', currency_code: 'RUB', priority: 1, target_amount: 0, deadline: null, starting_balance: 0, pace_amount: 0, completed: false, ...extra });

test('Подарки 63000 к 23.12 и Лазерка 12100 к 22.11 успевают без ручной правки; велосипед копится позже', () => {
  const dates = ['2026-11-05', '2026-11-20', '2026-12-04', '2026-12-18', '2027-05-20'];
  const periods = dates.map((date, i) => ({ id: `p${i}`, year: Number(date.slice(0, 4)), pay_date: date,
    window_start: date, window_end: date, calc_mode: 'manual', income_net: [15000, 15000, 9000, 9000, 100000][i] }));
  const st = plan({ periods, goals: [
    goal('gifts', { kind_code: 'gifts', target_amount: 63000, starting_balance: 18500, deadline: '2026-12-23' }),
    goal('laser', { target_amount: 12100, starting_balance: 8960, deadline: '2026-11-22' }),
    goal('bike', { target_amount: 100000, deadline: '2027-06-01', priority: 2 }),
  ] });
  for (const manual of [false, true]) {
    st.savings.savings_period_overrides = manual ? [{ period_id: 'p0', goal_id: 'gifts', amount: 12500 }] : [];
    const sim = simulate(st, createConfig(st), { today: '2026-10-22' });
    assert.ok(sim.milestoneDates.gifts[0] && sim.milestoneDates.gifts[0] <= '2026-12-23', `Подарки готовы к сроку: manual=${manual}; ${JSON.stringify(sim.rows.map(r => r.allocations))}`);
    assert.ok(sim.milestoneDates.laser[0] && sim.milestoneDates.laser[0] <= '2026-11-22', 'Лазерка готова к сроку');
    assert.ok(sim.milestoneDates.bike[0] && sim.milestoneDates.bike[0] <= '2027-06-01', 'Велосипед тоже успевает');
    assert.ok(sim.rows.every(r => r.unallocated >= -0.01), 'не создаём дефицит');
    if (manual) assert.equal(sim.rows[0].allocations.gifts, 12500, 'ручная сумма не меняется');
    assert.ok(sim.rows[0].allocations.gifts > 11125 || manual, 'часть взноса переносится из бедных декабрьских выплат');
  }
});

test('добавленный вручную взнос покрывает будущую трату: автопересчёт не оставляет новый недобор', () => {
  const dates = ['2027-01-05', '2027-01-20', '2027-02-05', '2027-02-20'];
  const periods = dates.map((d, i) => ({ id: `p${i}`, year: 2027, pay_date: d, window_start: d, window_end: d, income_net: 2250 }));
  const st = plan({ periods, goals: [goal('g', { target_amount: 5000, deadline: '2027-02-25' }),
    goal('later', { target_amount: 100000, deadline: '2027-12-31', priority: 2 })],
    txs: [{ id: 'out', goal_id: 'g', date: '2027-02-10', kind: 'spend', amount: 1000 }],
    overrides: [{ period_id: 'p0', goal_id: 'g', amount: 2250 }] });
  const sim = run(st);
  assert.equal(sim.rows[0].allocations.g, 2250);
  assert.equal(goalBalanceAt(sim, st.savings.goals[0], st.savings.goal_transactions, '2027-02-25'), 5000);
  assert.ok(sim.milestoneDates.g[0] <= '2027-02-25');
  assert.ok(sim.rows.every(r => r.unallocated >= -0.01));
});

test('распределение: ближайшая и следующая цели успевают при разных размерах четырёх выплат', () => {
  const dates = ['2026-11-05', '2026-11-20', '2026-12-04', '2026-12-18', '2027-05-20'];
  for (const a of [1000, 2000, 4000]) for (const b of [1000, 2000, 4000])
    for (const c of [1000, 2000, 4000]) for (const d of [1000, 2000, 4000]) {
      if (a + b + c + d < 7000) continue;
      const amounts = [a, b, c, d, 10000];
      const periods = dates.map((date, i) => ({ id: `p${i}`, year: Number(date.slice(0, 4)), pay_date: date,
        window_start: date, window_end: date, income_net: amounts[i] }));
      const st = plan({ periods, goals: [goal('gift', { kind_code: 'gifts', target_amount: 5000, deadline: '2026-12-23' }),
        goal('soon', { target_amount: 2000, deadline: '2026-11-22' }), goal('later', { target_amount: 10000, deadline: '2027-06-01', priority: 2 })] });
      const sim = run(st);
      const label = amounts.join('/');
      assert.ok(sim.milestoneDates.soon[0] && sim.milestoneDates.soon[0] <= '2026-11-22', `ближайшая: ${label}`);
      assert.ok(sim.milestoneDates.gift[0] && sim.milestoneDates.gift[0] <= '2026-12-23', `подарок: ${label}`);
      for (const r of sim.rows) {
        assert.ok(r.unallocated >= -0.01, `без дефицита: ${label}`);
        const allocated = Object.values(r.allocations).reduce((s, x) => s + x, 0);
        assert.ok(Math.abs(r.totalIncome - allocated - r.unallocated) < 0.01, 'деньги не появляются из расчёта');
      }
    }
});

test('фиксация выплаты с одной ручной суммой сохраняет также остальные автоматические отчисления', () => {
  const st = plan({ periods: payouts([1], { net: 1000 }), goals: [goal('a', { target_amount: 500 }), goal('b', { target_amount: 2000, priority: 2 })] });
  const id = st.income.periods[0].id;
  st.savings.savings_period_overrides = [{ period_id: id, goal_id: 'a', amount: 200 }];
  const before = run(st);
  const frozen = freezePeriods(st, before, [id]);
  st.income.periods = frozen.periods;
  st.savings.savings_period_overrides = frozen.savings_period_overrides;
  st.debts.credit_payment_overrides = frozen.credit_payment_overrides;
  const after = run(st);
  assert.deepEqual(after.byId.get(id).allocations, before.byId.get(id).allocations);
});

test('несколько этапов Подарков: заранее учитывается следующий срок, штатная трата не удваивает потребность', () => {
  const dates = ['2026-11-05', '2026-11-20', '2026-12-04', '2026-12-18'];
  const periods = dates.map((date, i) => ({ id: `p${i}`, year: 2026, pay_date: date, window_start: date, window_end: date, income_net: [6000, 0, 1000, 1000][i] }));
  const st = plan({ periods, goals: [goal('gifts', { kind_code: 'gifts' }), goal('bike', { target_amount: 100000, deadline: '2027-06-01' })],
    milestones: [{ id: 'nov', goal_id: 'gifts', target: 5000, deadline: '2026-11-22' }, { id: 'dec', goal_id: 'gifts', target: 3000, deadline: '2026-12-23' }],
    txs: [{ id: 'spend', goal_id: 'gifts', milestone_id: 'nov', date: '2026-11-22', amount: 5000, kind: 'spend' }] });
  const sim = run(st);
  assert.equal(sim.rows[0].allocations.gifts, 6000);
  assert.ok(sim.milestoneDates.gifts[0] <= '2026-11-22');
  assert.ok(sim.milestoneDates.gifts[1] <= '2026-12-23');
  assert.equal(goalBalanceAt(sim, st.savings.goals[0], st.savings.goal_transactions, '2026-12-23'), 3000);
  assert.equal(sim.rows.reduce((s, r) => s + (r.allocations.gifts ?? 0), 0), 8000);
});

test('будущий ручной взнос учитывается заранее, в том числе в зафиксированной выплате', () => {
  for (const locked of [false, true]) {
    const periods = payouts([1], { net: 10000 });
    periods[1].locked = locked;
    const st = plan({ periods, goals: [goal('g', { target_amount: 5000, deadline: '2027-02-10' }), goal('later', { target_amount: 100000, priority: 2 })],
      overrides: [{ period_id: periods[1].id, goal_id: 'g', amount: 5000 }] });
    const sim = run(st);
    assert.equal(sim.rows[0].allocations.g, undefined, 'нет ненужного двойного накопления');
    assert.equal(sim.rows[1].allocations.g, 5000);
    assert.equal(goalBalanceAt(sim, st.savings.goals[0], [], '2027-02-10'), 5000);
  }
});

test('рассрочка: пересчёт сохраняет ручные поля будущих платежей и делит остаток между автоматическими', async () => {
  const { buildInstallmentSchedule, rebuildFuture } = await import('../src/engine/debts.js');
  const inst = { id: 'i', total: 1000, parts: 4, every_n: 1, period_unit: 'month', first_date: '2027-01-10' };
  const payments = buildInstallmentSchedule(inst);
  payments[1].amount = 500;
  payments[1].pay_date = '2027-02-15';
  payments[1].manual_fields = ['amount', 'pay_date'];
  const next = rebuildFuture({ ...inst, total: 1400 }, payments, '2027-02-01');
  assert.equal(next[1].amount, 500);
  assert.equal(next[1].pay_date, '2027-02-15');
  assert.deepEqual(next[1].manual_fields, ['amount', 'pay_date']);
  assert.deepEqual(next.map(p => p.amount), [250, 500, 325, 325]);
});

test('закрытая цель: будущая ручная сумма освобождается, история и баланс сохраняются', () => {
  for (const archived of [false, true]) {
    const periods = payouts([1], { net: 1000 });
    const [past, future] = periods;
    past.locked = true;
    const closed = goal('closed', { completed: true, archived, priority: null, target_amount: 500,
      completion_snapshot: { date: past.pay_date, progress: 200, phase: { idx: 0, saved: 200 }, milestones: [] } });
    const active = goal('active', { target_amount: 10000 });
    const st = plan({ periods, goals: [closed, active], overrides: [
      { period_id: past.id, goal_id: closed.id, amount: 200 },
      { period_id: future.id, goal_id: closed.id, amount: 900 },
    ] });
    const sim = simulate(st, createConfig(st), { today: past.pay_date });
    assert.equal(sim.byId.get(past.id).allocations.closed, 200);
    assert.equal(sim.byId.get(future.id).allocations.closed, undefined);
    assert.equal(sim.byId.get(future.id).allocations.active, 1000, 'освободившаяся сумма доступна активным целям');
    assert.equal(goalBalanceAt(sim, closed, [], future.pay_date), 200);
    assert.equal(goalProgressAt(sim, closed, future.pay_date), 200);
    assert.deepEqual(goalNeedAt(sim, closed, [], past.pay_date), { need: 0, deadline: '' });
    assert.equal(reservePaceSuggestion(sim, closed, past.pay_date).suggested, 0);
    assert.equal(forecastBeyondPlan(sim, closed), null);
    assert.equal(st.savings.savings_period_overrides.length, 2, 'исходная история не удалена');
  }
});

test('скрытие с Обзора не меняет расчёт и прогноз активной цели', () => {
  const st = plan({ goals: [goal('g', { target_amount: 10000 })] });
  const before = run(st);
  st.savings.goals[0].hidden_overview = true;
  const after = run(st);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.milestoneDates, before.milestoneDates);
});

test('закрытая цель: накопленный будущий этап сохраняется после траты и перевода', () => {
  for (const kind of ['spend', 'transfer_out']) {
    const g = goal('g', { starting_balance: 100 });
    const st = plan({ periods: [], goals: [g], milestones: [
      { id: 'm1', goal_id: 'g', target: 100, deadline: '2027-06-01' },
      { id: 'm2', goal_id: 'g', target: 100, deadline: '2027-07-01' },
    ], txs: [{ id: 'out', goal_id: 'g', date: '2027-03-02', amount: 100, kind }] });
    const before = run(st);
    assert.equal(before.milestoneDates.g[0], null, 'в открытой цели будущая трата откатывает этап');
    g.completion_snapshot = snapshotGoalCompletion(before, g, '2027-03-01');
    g.completed = true;
    const sim = run(JSON.parse(JSON.stringify(st))); // повторная загрузка сохранённого плана
    const savedGoal = sim.goals[0];
    assert.equal(goalProgressAt(sim, savedGoal, '2027-03-03'), 100);
    assert.deepEqual(sim.milestoneDates.g, ['pre', null]);
    assert.deepEqual(sim.milestoneFunded.g, [0, null]);
    assert.equal(goalBalanceAt(sim, savedGoal, st.savings.goal_transactions, '2027-03-03'), 0);
    assert.deepEqual(sim.ledgerOf('g').at(-1).reopened, []);
    assert.deepEqual(sim.finalPhase.phase.g, { idx: 1, saved: 0 });
  }
});

test('закрытая цель: частичный прогресс неизменен при минусе и последующих пополнениях', () => {
  const g = goal('g', { starting_balance: 150 });
  const st = plan({ periods: [], goals: [g], milestones: [
    { id: 'm1', goal_id: 'g', target: 100, deadline: '2027-06-01' },
    { id: 'm2', goal_id: 'g', target: 100, deadline: '2027-07-01' },
  ], txs: [
    { id: 'out', goal_id: 'g', date: '2027-03-02', amount: 180, kind: 'spend' },
    { id: 'in', goal_id: 'g', date: '2027-03-04', amount: 500, kind: 'deposit' },
  ] });
  g.completion_snapshot = snapshotGoalCompletion(run(st), g, '2027-03-01');
  g.completed = true;
  const sim = run(st);
  assert.equal(goalProgressAt(sim, g, '2027-03-03'), 150);
  assert.equal(goalBalanceAt(sim, g, st.savings.goal_transactions, '2027-03-03'), -30);
  assert.equal(goalProgressAt(sim, g, '2027-03-05'), 150);
  assert.equal(goalBalanceAt(sim, g, st.savings.goal_transactions, '2027-03-05'), 470);
  assert.deepEqual(sim.milestoneDates.g, ['pre', null], 'пополнение не закрывает новые этапы закрытой цели');
  assert.deepEqual(sim.finalPhase.phase.g, { idx: 1, saved: 50 });
});

test('снимок закрытия учитывает движения до сегодняшнего дня и исключает будущие', () => {
  const g = goal('g', { starting_balance: 200 });
  const st = plan({ periods: [], goals: [g], milestones: [
    { id: 'm1', goal_id: 'g', target: 100, deadline: '2027-06-01' },
    { id: 'm2', goal_id: 'g', target: 100, deadline: '2027-07-01' },
    { id: 'm3', goal_id: 'g', target: 100, deadline: '2027-08-01' },
  ], txs: [
    { id: 'past', goal_id: 'g', date: '2027-02-28', amount: 80, kind: 'spend' },
    { id: 'today', goal_id: 'g', date: '2027-03-01', amount: 10, kind: 'deposit' },
    { id: 'future', goal_id: 'g', date: '2027-03-02', amount: 500, kind: 'deposit' },
  ] });
  const snapshot = snapshotGoalCompletion(run(st), g, '2027-03-01');
  assert.equal(snapshot.progress, 130);
  assert.deepEqual(snapshot.phase, { idx: 1, saved: 30 });
  assert.deepEqual(snapshot.milestones.map(m => m.date), ['pre', null, null]);
});

test('закрытая цель без этапов: накопленная сумма сохраняется после последней выплаты плана', () => {
  const g = goal('g', { starting_balance: 100, target_amount: 100, deadline: '2027-12-31' });
  const st = plan({ periods: [], goals: [g], txs: [
    { id: 'out', goal_id: 'g', date: '2027-03-01', amount: 100, kind: 'spend' },
  ] });
  g.completion_snapshot = snapshotGoalCompletion(run(st), g, '2027-02-28');
  g.completed = true;
  const sim = run(st);
  assert.equal(goalProgressAt(sim, g, '2027-03-01'), 100);
  assert.equal(goalBalanceAt(sim, g, st.savings.goal_transactions, '2027-03-01'), 0);
  assert.deepEqual(sim.milestoneDates.g, ['pre']);
});

test('конвейер: сохраняет доход и обязательные расходы старого плана, распределение учитывает будущие траты', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-2027.json', import.meta.url), 'utf8'));
  // старая версия не откладывала темп подушки раньше копилок — для сверки выключаем
  const sim = simulate(fx.state, createConfig(fx.state), { paceFirst: false });
  assert.equal(sim.rows.length, fx.expected.length);
  const near = (a, b, what) => assert.ok(Math.abs((a ?? 0) - (b ?? 0)) < 0.01, `${what}: ${a} ≠ ${b}`);

  /* Отпускные в старой версии были суммой «на руки», в новой считаются
     начисленными и облагаются налогом при выплате. Поэтому доход и всё, что из
     него следует, сверяем до первой выплаты с отпускными; расходы и рассрочки
     от дохода не зависят и сверяются на всём плане. */
  const firstVac = sim.rows.findIndex(r => r.income.vacationPay > 0);
  assert.ok(firstVac > 0, 'в плане сверки есть отпуск');

  fx.expected.forEach((e, i) => {
    const r = sim.rows[i];
    assert.equal(r.period.id, e.id);
    near(r.categoriesTotal + r.installmentsTotal, e.expenses, `${e.id} расходы`);
    if (i >= firstVac) return;
    near(r.totalIncome, e.income, `${e.id} доход`);
    const sum = x => Object.values(x).reduce((a, b) => a + b, 0);
    near(r.totalIncome, r.categoriesTotal + r.installmentsTotal + sum(r.allocations) + sum(r.debtPayments) + r.unallocated, `${e.id} сохранение денег`);
  });
});

test('конвейер: копилка со сроком получает темп, остаток доливается', () => {
  const st = plan({
    goals: [goal('trip', { target_amount: 60000, deadline: '2027-03-25' }), goal('car', { target_amount: 1e6, priority: 2 })],
    categories: [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }],
  });
  const sim = run(st);
  const first = sim.rows[0];                        // 20.01, до срока 5 выплат
  assert.equal(first.categoriesTotal, 50000);
  assert.equal(first.allocations.trip, 50000);       // темп 12 000, остальное доливкой по сроку
  assert.equal(first.allocations.car, undefined);
  const second = sim.rows[1];
  assert.equal(second.allocations.trip, 10000);      // этап закрыт
  assert.equal(second.allocations.car, 40000);
  assert.equal(sim.milestoneDates.trip[0], '2027-02-05');
});

test('конвейер: порядок этапов из настроек и выключенный этап', () => {
  const goals = [goal('trip', { target_amount: 1e6, deadline: '2027-12-31' })];
  const categories = [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }];
  const off = run(plan({ goals, categories, rules: [{ stage_code: 'categories', priority: 1, enabled: false, params: {} }] }));
  assert.equal(off.rows[0].byStage.categories, undefined);
  assert.equal(off.rows[0].allocations.trip, 100000);

  // копилки раньше расходов: темп берётся из полной выплаты, расходы уходят в минус
  const first = run(plan({ goals, categories, rules: [{ stage_code: 'buckets', priority: 0, enabled: true, params: {} }] }));
  assert.deepEqual(first.stages.map(s => s.code).slice(0, 2), ['buckets', 'categories']);
  assert.ok(first.rows[0].byStage.buckets > 0);
});

test('конвейер: подушка — темп, потом доливка после копилок', () => {
  const sim = run(plan({
    periods: payouts([1]),
    goals: [goal('cushion', { kind_code: 'reserve', target_amount: 1e6, pace_amount: 7000 }), goal('trip', { target_amount: 50000, deadline: '2027-06-01' })],
  }));
  const r = sim.rows[0];
  assert.equal(r.byStage.reserves, 7000);
  assert.equal(r.allocations.trip, 50000);           // доливка: копилки раньше подушек
  assert.equal(r.allocations.cushion, 7000 + 43000);
  assert.equal(r.unallocated, 0);
});

test('конвейер: зафиксированная выплата — только ручные суммы, без авто-погашений', () => {
  const periods = payouts([1]);
  periods[0].locked = true;
  const sim = run(plan({
    periods,
    goals: [goal('trip', { target_amount: 1e6, deadline: '2027-12-31' })],
    overrides: [{ period_id: periods[0].id, goal_id: 'trip', amount: 1234 }],
    cards: [{ id: 'k', grace_days: 60, currency_code: 'RUB' }],
    ops: [{ id: 'o', card_id: 'k', op_date: '2027-01-10', amount: 5000, kind: 'spend' }],
  }));
  assert.deepEqual(sim.rows[0].allocations, { trip: 1234 });
  assert.deepEqual(sim.rows[0].debtPayments, {});
  assert.equal(sim.rows[0].unallocated, 100000 - 1234);
  assert.ok(sim.rows[1].allocations.trip > 0);       // следующая — снова автоматически
});

test('конвейер: досрочное погашение можно выключить', () => {
  const base = { periods: payouts([1]), cards: [{ id: 'k', grace_days: 60, currency_code: 'RUB' }],
    ops: [{ id: 'o', card_id: 'k', op_date: '2027-01-10', amount: 40000, kind: 'spend' }] };
  const on = run(plan(base));
  assert.equal(on.rows[0].debtPayments.k, 40000);
  const off = run(plan({ ...base, rules: [{ stage_code: 'credits', priority: 4, enabled: true, params: { early_repayment: false } }] }));
  assert.ok(off.rows[0].debtPayments.k < 40000);      // только по графику до срока
  assert.equal(off.rows[0].byStage.early_repayment, 0);
});

test('конвейер: цель в долларах копится по курсу, без курса — предупреждение', () => {
  const goals = [goal('usd', { currency_code: 'USD', target_amount: 1000, deadline: '2027-01-25' })];
  const withRate = run(plan({ periods: payouts([1]), goals, fx: [{ base_code: 'RUB', quote_code: 'USD', rate_date: '2027-01-01', rate: 90 }] }));
  assert.equal(withRate.rows[0].allocations.usd, 90000);
  assert.equal(withRate.rows[0].goalBalances.usd, 1000);
  const noRate = run(plan({ periods: payouts([1]), goals }));
  assert.equal(noRate.rows[0].allocations.usd, undefined);
  assert.ok(noRate.warnings.some(w => w.code === 'no_fx_rate' && w.goal_id === 'usd'));
});

test('после расчёта: баланс на дату, прогноз карты, темп подушки, перераспределение, фиксация', () => {
  const txs = [{ id: 't', goal_id: 'trip', date: '2027-02-10', amount: 20000, kind: 'spend' }];
  const st = plan({
    goals: [goal('trip', { target_amount: 30000, deadline: '2027-02-15' }), goal('cushion', { kind_code: 'reserve', target_amount: 200000, priority: 2 }),
      goal('old', { target_amount: 0, completed: true })],
    txs,
    categories: [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }],
    cards: [{ id: 'k', grace_days: 30, currency_code: 'RUB' }],
    ops: [{ id: 'o', card_id: 'k', op_date: '2027-03-01', amount: 30000, kind: 'spend' }],
  });
  const sim = run(st);
  assert.equal(goalBalanceAt(sim, st.savings.goals[0], txs, '2027-02-12'), 30000, 'план заранее восполнил трату до срока цели');
  const fc = cardForecast(sim, st.debts.credit_cards[0], st.debts.credit_card_ops, '2027-03-02');
  assert.equal(fc.state.debt, 30000);
  assert.equal(fc.cycle.deadline, '2027-03-31');
  assert.equal(fc.cycle.closed, '2027-03-20');         // единственная выплата до срока — весь долг
  const pace = reservePaceSuggestion(sim, st.savings.goals[1], '2027-01-01');
  assert.ok(pace.suggested <= pace.avgFree + 1e-9);
  const offer = proposeRedistribution(sim, st.savings.goals[2], 50000, '2027-01-01', txs);
  assert.deepEqual(offer.map(o => o.goal_id), ['trip', 'cushion']);
  assert.equal(offer[0].amount, 30000);

  const frozen = freezePeriods(st, sim, [sim.rows[0].period.id]);
  assert.equal(frozen.periods.find(p => p.id === sim.rows[0].period.id).locked, true);
  assert.ok(frozen.savings_period_overrides.length > 0);
  assert.ok(frozen.savings_period_overrides.every(o => Number.isInteger(o.amount)));
});

test('milestonesOf: цель без этапов — один этап из суммы и срока', () => {
  assert.deepEqual(milestonesOf(goal('g', { target_amount: 5, deadline: '2027-01-01' }), []).map(m => [m.target, m.deadline]), [[5, '2027-01-01']]);
});

test('рассрочка: пересборка графика не трогает прошедшие платежи', async () => {
  const { rebuildFuture } = await import('../src/engine/debts.js');
  const inst = { id: 'i', total: 1000, parts: 4, every_n: 1, period_unit: 'month', first_date: '2027-01-10' };
  const payments = [
    { id: 'i-1', installment_id: 'i', pay_date: '2027-01-10', amount: 250, paid: true },
    { id: 'i-2', installment_id: 'i', pay_date: '2027-02-10', amount: 250 },
    { id: 'i-3', installment_id: 'i', pay_date: '2027-03-10', amount: 250 },
    { id: 'i-4', installment_id: 'i', pay_date: '2027-04-10', amount: 250 },
  ];
  // сумма выросла до 1300 в феврале: январский платёж остаётся, остальные делят 1050
  const next = rebuildFuture({ ...inst, total: 1300 }, payments, '2027-02-01', UNITS);
  assert.deepEqual(next.map(p => [p.pay_date, p.amount]), [
    ['2027-01-10', 250], ['2027-02-10', 350], ['2027-03-10', 350], ['2027-04-10', 350],
  ]);
  // частей стало больше — добавились даты по той же периодичности
  const more = rebuildFuture({ ...inst, parts: 5 }, payments, '2027-02-01', UNITS);
  assert.equal(more.length, 5);
  assert.equal(more.at(-1).pay_date, '2027-05-10');
  // все платежи прошли — график не трогаем
  assert.equal(rebuildFuture(inst, payments, '2027-12-31', UNITS).length, 4);
});

test('прогноз: цель без срока досчитывается за пределами плана', async () => {
  const { forecastBeyondPlan } = await import('../src/engine/allocation.js');
  const st = plan({
    goals: [goal('car', { target_amount: 1200000 })],
    categories: [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }],
  });
  const sim = run(st);
  assert.equal(sim.milestoneDates.car[0], null);          // внутри плана не закрывается
  const f = forecastBeyondPlan(sim, st.savings.goals[0]);
  assert.ok(f, 'прогноз должен появиться');
  assert.equal(f.beyondPlan, true);
  assert.ok(f.date > sim.planEnd, 'дата прогноза — после конца плана');
  assert.ok(f.perPayout > 0);
});

test('прогноз: цели, которой ничего не достаётся, прогноза нет', async () => {
  const { forecastBeyondPlan } = await import('../src/engine/allocation.js');
  const st = plan({
    goals: [goal('car', { target_amount: 1e7, deadline: '2027-06-30' }), goal('later', { target_amount: 50000, priority: 9 })],
    categories: [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }],
  });
  const sim = run(st);
  assert.equal(forecastBeyondPlan(sim, st.savings.goals[1]), null);
});

test('подушка: заданный темп откладывается раньше копилок', () => {
  const goals = [
    goal('trip', { target_amount: 500000, priority: 1 }),
    goal('cushion', { kind_code: 'reserve', target_amount: 300000, pace_amount: 8000, priority: 1 }),
  ];
  const st = plan({ periods: payouts([1]), goals,
    categories: [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }] });
  const first = run(st).rows[0];
  assert.equal(first.allocations.cushion, 8000);          // темп ушёл раньше копилки
  assert.equal(first.allocations.trip, 42000);            // копилке — остаток выплаты
  // без темпа подушка снова получает только то, что осталось после копилок
  goals[1].pace_amount = 0;
  const without = run(plan({ periods: payouts([1]), goals,
    categories: [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }] })).rows[0];
  assert.equal(without.allocations.cushion, undefined);
  assert.equal(without.allocations.trip, 50000);
});

test('копилки: ручная сумма фиксируется, остальные считаются автоматически', () => {
  const goals = [
    goal('trip', { target_amount: 500000, priority: 1 }),
    goal('car', { target_amount: 500000, priority: 2 }),
  ];
  const st = plan({ periods: payouts([1]), goals,
    categories: [{ id: 'life', mode: 'fixed_month', monthly_amount: 100000, split_mode: 'even' }],
    overrides: [{ period_id: '2027-01-1', goal_id: 'trip', amount: 5000 }] });
  const first = run(st).rows[0];
  assert.equal(first.allocations.trip, 5000);             // ровно то, что ввели руками
  assert.equal(first.allocations.car, 45000);             // остальное разошлось автоматически
  assert.equal(first.unallocated, 0);
});

test('шаблон: правленое вхождение не перезаписывается, и его трата остаётся', () => {
  const goal = { id: 'g', title: 'Химия', kind_code: 'bucket', currency_code: 'RUB' };
  const cycle = { id: 'c1', goal_id: 'g', title: 'Химия', amount: 15000,
    start_date: '2027-03-01', every_n: 3, period_unit: 'month', repeats: 3, auto_spend: true, enabled: true };
  const base = { goals: [goal], goal_cycles: [cycle], goal_milestones: [], goal_transactions: [], goal_cycle_skips: [] };
  const args = { until: '2027-12-31', years: [2027], today: '2027-01-01', units: UNITS, goalKinds: { bucket: 'buckets' } };

  const first = syncGenerated({ savings: base, ...args });
  assert.equal(first.goal_milestones.length, 3);
  assert.equal(first.goal_transactions.length, 3);

  // правим сумму второго этапа руками
  const ms = first.goal_milestones.map(m => (m.deadline === '2027-06-01' ? { ...m, target: 22000, user_edited: true } : m));
  const after = syncGenerated({ savings: { ...base, goal_milestones: ms, goal_transactions: first.goal_transactions }, ...args });

  const edited = after.goal_milestones.find(m => m.deadline === '2027-06-01');
  assert.equal(edited.target, 22000, 'правка руками сохраняется');
  assert.equal(after.goal_milestones.length, 3, 'дубликатов не появилось');
  // трата этого вхождения никуда не делась
  const tx = after.goal_transactions.find(t => t.milestone_id === edited.id);
  assert.ok(tx, 'трата закреплённого этапа осталась');
  assert.equal(after.goal_transactions.length, 3);
  // соседние вхождения шаблон по-прежнему ведёт сам
  assert.equal(after.goal_milestones.find(m => m.deadline === '2027-09-01').target, 15000);
});
