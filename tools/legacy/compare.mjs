import { loadOld } from './old.mjs';
import { toV2 } from './convert.mjs';
import { simulate } from '../../src/engine/allocation.js';
import { createConfig } from '../../src/core/config.js';

const REF = {
  setting_defaults: [
    ['base_currency', 'RUB'], ['calendar_code', 'ru'], ['avg_days_in_month', 29.3], ['rounding', 1],
    ['planned_spend_window_days', 45], ['locale', 'ru-RU', 'user'], ['extra_currencies', []],
  ].map(([key, value, scope = 'account']) => ({ key, value, scope })),
  calendar_days: [[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],[1,8],[2,23],[3,8],[5,1],[5,9],[6,12],[11,4]].map(([month, day]) => ({ calendar_code: 'ru', rule: 'fixed', kind: 'holiday', day, month })),
  allocation_stages: ['categories', 'gifts', 'installments', 'credits', 'buckets', 'reserves'].map((code, i) => ({ code, title: code, default_priority: i + 1 })),
  goal_kinds: [{ code: 'bucket', stage_code: 'buckets' }, { code: 'reserve', stage_code: 'reserves' }, { code: 'gifts', stage_code: 'gifts' }],
  currencies: [{ code: 'RUB', symbol: '₽' }],
};

export function scenario(name, mutate) {
  const old = loadOld();
  const st = JSON.parse(JSON.stringify(old.DEFAULT_STATE));
  st.debts = { cards: [], paymentOverrides: {}, installments: [], goalSettings: {}, gifts: [] };
  mutate(st);
  const a = old.simulate(st);
  const v2 = toV2(st, REF);
  const b = simulate(v2, createConfig(v2));
  let maxDiff = 0; const diffs = [];
  const cmp = (what, x, y, tol = 1.01) => {
    const d = Math.abs((x || 0) - (y || 0));
    if (d > maxDiff) maxDiff = d;
    if (d > tol) diffs.push(`${what}: старая ${x?.toFixed?.(2)} новая ${y?.toFixed?.(2)}`);
  };
  a.rows.forEach((ra, i) => {
    const rb = b.rows[i];
    const pid = ra.period.id;
    if (rb.period.id !== pid) diffs.push(`порядок ${pid} ≠ ${rb.period.id}`);
    cmp(`${pid} доход`, ra.totalIncome, rb.totalIncome);
    cmp(`${pid} расходы`, ra.expenses, rb.categoriesTotal + rb.installmentsTotal);
    cmp(`${pid} остаток`, ra.unallocated, rb.unallocated, 2.5);
    const goals = new Set([...Object.keys(ra.allocations), ...Object.keys(rb.allocations)]);
    for (const g of goals) cmp(`${pid} → ${g}`, ra.allocations[g], rb.allocations[g], 2.5);
    const cards = new Set([...Object.keys(ra.debtPayments), ...Object.keys(rb.debtPayments)]);
    for (const c of cards) cmp(`${pid} карта ${c}`, ra.debtPayments[c], rb.debtPayments[c], 2.5);
    for (const g of Object.keys(ra.goalSnapshot)) cmp(`${pid} баланс ${g}`, ra.goalSnapshot[g], rb.goalBalances[g], 5);
  });
  for (const g of Object.keys(a.milestoneDates)) {
    const x = JSON.stringify(a.milestoneDates[g]); const y = JSON.stringify(b.milestoneDates[g]);
    if (x !== y) diffs.push(`этапы ${g}: старая ${x} новая ${y}`);
  }
  console.log(`${diffs.length ? 'РАЗНИЦА' : 'СОВПАДАЕТ'}  ${name}  (строк ${a.rows.length}, макс. расхождение ${maxDiff.toFixed(2)} ₽)`);
  diffs.slice(0, 12).forEach(d => console.log('   ', d));
  return diffs.length === 0;
}

scenario('план по умолчанию', () => {});
scenario('подушки с темпом и подарочная копилка', st => {
  st.debts.goalSettings = { 'goal-cushion': { kind: 'reserve', pace: 5000 }, 'goal-currency': { kind: 'reserve', pace: 3000 } };
  st.goals.push({ id: 'goal-gifts', name: 'Подарки', priority: 6, target: 0, deadline: '', startingBalance: 0, completed: false,
    subgoals: [{ id: 'g1', name: 'ДР мамы', target: 10000, deadline: '2027-03-15' }, { id: 'g2', name: 'ДР Вики', target: 5000, deadline: '2027-06-01' }],
    withdrawals: [{ date: '2027-03-15', amount: 10000, note: 'ДР мамы' }, { date: '2027-06-01', amount: 5000, note: 'ДР Вики' }] });
  st.debts.goalSettings['goal-gifts'] = { kind: 'gifts', pace: 0 };
});
scenario('кредитка, рассрочка, переводы между копилками', st => {
  st.debts.cards = [{ id: 'card1', name: 'Карта', limit: 100000, graceDays: 55, ops: [
    { id: 'o1', date: '2027-02-10', amount: 60000, kind: 'spend' },
    { id: 'o2', date: '2027-03-01', amount: 15000, kind: 'spend' },
    { id: 'o3', date: '2027-05-10', amount: 20000, kind: 'payment' },
    { id: 'o4', date: '2027-07-01', amount: 30000, kind: 'spend' }] }];
  st.debts.installments = [{ id: 'i1', name: 'Телефон', total: 60000, parts: 6, interval: '2w', firstDate: '2027-03-03',
    payments: [0, 1, 2, 3, 4, 5].map(k => ({ id: 'ip' + k, date: new Date(Date.UTC(2027, 2, 3 + 14 * k)).toISOString().slice(0, 10), amount: 10000 })) }];
  st.goals.find(g => g.id === 'goal-implant').withdrawals = [{ date: '2027-05-01', amount: -20000, note: 'перевод' }];
  st.goals.find(g => g.id === 'goal-currency').withdrawals = [{ date: '2027-05-01', amount: 20000, note: 'перевод' }];
});
scenario('зафиксированные выплаты и ручные суммы', st => {
  st.periods.filter(p => p.date < '2027-03-01').forEach(p => { p.locked = true; });
  st.savingsOverrides = { p2: { 'goal-travel': 30000 }, p3: {}, p6: { 'goal-implant': 10000, 'goal-cushion': 5000 } };
  st.categoryOverrides = { p4: { 'cat-joy': 0 }, p8: { 'cat-life': 20000 } };
  st.debts.cards = [{ id: 'card1', name: 'Карта', limit: 100000, graceDays: 60, ops: [{ id: 'o1', date: '2027-01-25', amount: 40000, kind: 'spend' }] }];
  st.debts.paymentOverrides = { p5: { card1: 5000 } };
});
scenario('закрытая цель и больничный', st => {
  st.goals.find(g => g.id === 'goal-iphone').completed = true;
  st.sickLeaves = [{ id: 's1', start: '2027-03-10', end: '2027-03-20', note: '' }];
});
