/* Тесты этапа 4: расходы, долги, накопления, конвейер распределения. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planExpenses, inSeason } from '../src/engine/expenses.js';
import { buildInstallmentSchedule, installmentsByPeriod, newCardState, cardApplyOp, cardApplyPayment } from '../src/engine/debts.js';
import { createTracker, cycleDates, giftAmountForYear, syncGenerated, milestonesOf } from '../src/engine/savings.js';
import { simulate, freezePeriods, goalBalanceAt, reservePaceSuggestion, proposeRedistribution, cardForecast } from '../src/engine/allocation.js';
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

test('копилка: плановая трата не откатывает этап, ранняя — откатывает', () => {
  const goals = [{ id: 'g', title: 'Путешествия' }];
  const milestones = [
    { id: 'a', goal_id: 'g', target: 100, deadline: '2027-04-01' },
    { id: 'b', goal_id: 'g', target: 100, deadline: '2027-08-01' },
  ];
  const t = createTracker({ goals, milestones });
  t.deposit('g', 150, '2027-03-01');
  assert.deepEqual(t.phase('g'), { idx: 1, saved: 50 });
  t.withdraw('g', 100, '2027-03-25');              // за 7 дней до срока — плановая
  assert.deepEqual(t.phase('g'), { idx: 1, saved: 50 });
  assert.equal(t.milestoneDates().g[0], '2027-03-01');

  const t2 = createTracker({ goals, milestones });
  t2.deposit('g', 150, '2027-01-01');
  t2.withdraw('g', 120, '2027-01-10');             // за 81 день до срока — чужие деньги
  assert.deepEqual(t2.phase('g'), { idx: 0, saved: 30 });
  assert.equal(t2.milestoneDates().g[0], null);
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

test('конвейер: совпадает с расчётом старой версии на её плане', () => {
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
    near(r.unallocated, e.unallocated, `${e.id} остаток`);
    for (const k of new Set([...Object.keys(e.allocations), ...Object.keys(r.allocations)])) near(r.allocations[k], e.allocations[k], `${e.id} → ${k}`);
    for (const k of new Set([...Object.keys(e.debtPayments), ...Object.keys(r.debtPayments)])) near(r.debtPayments[k], e.debtPayments[k], `${e.id} карта ${k}`);
    for (const k of Object.keys(e.balances)) near(r.goalBalances[k], e.balances[k], `${e.id} баланс ${k}`);
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
  assert.equal(goalBalanceAt(sim, st.savings.goals[0], txs, '2027-02-12'), 30000 - 20000);
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
