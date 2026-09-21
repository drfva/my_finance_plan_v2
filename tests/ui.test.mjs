/* Тесты правки данных из разметки (ui/edit.js) — без браузера */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, deleteRow, addRow, findRow } from '../src/ui/edit.js';
import { createFormat } from '../src/core/format.js';

const fmt = createFormat({ locale: 'ru-RU', currency: 'RUB', rounding: 1, currencies: [{ code: 'RUB', symbol: '₽' }] });

function fakeStore(state) {
  return {
    state,
    updates: [],
    update(domain, fn) { this.updates.push(domain); fn(state[domain] ?? (state[domain] = {}), state); },
  };
}
const el = (dataset, value) => ({ dataset, value, checked: value === true });

test('правка: число, дата, галочка и неразобранное значение', () => {
  const store = fakeStore({ income: { periods: [{ id: 'p1', income_net: 0, locked: false, pay_date: '2027-01-20' }] } });
  const key = JSON.stringify({ id: 'p1' });
  assert.equal(applyEdit(store, el({ edit: 'income|periods|income_net', key, type: 'money' }, '100 500,4'), fmt), true);
  assert.equal(store.state.income.periods[0].income_net, 100500);
  applyEdit(store, el({ edit: 'income|periods|pay_date', key, type: 'date' }, '2027-01-21'), fmt);
  applyEdit(store, el({ edit: 'income|periods|locked', key, type: 'bool' }, true), fmt);
  assert.equal(store.state.income.periods[0].pay_date, '2027-01-21');
  assert.equal(store.state.income.periods[0].locked, true);
  assert.equal(applyEdit(store, el({ edit: 'income|periods|income_net', key, type: 'money' }, 'сто'), fmt), false);
  assert.equal(store.state.income.periods[0].income_net, 100500);
});

test('правка: строки-правки создаются и исчезают', () => {
  const store = fakeStore({ expenses: {} });
  const key = JSON.stringify({ period_id: 'p1', category_id: 'c1' });
  applyEdit(store, el({ edit: 'expenses|expense_period_overrides|amount', key, type: 'money' }, '1000'), fmt);
  assert.deepEqual(store.state.expenses.expense_period_overrides, [{ period_id: 'p1', category_id: 'c1', amount: 1000 }]);
  applyEdit(store, el({ edit: 'expenses|expense_period_overrides|amount', key, type: 'money', removeWhen: '0' }, '0'), fmt);
  assert.deepEqual(store.state.expenses.expense_period_overrides, []);
});

test('правка: новая строка получает значения по умолчанию', () => {
  const store = fakeStore({ facts: {} });
  applyEdit(store, el({
    edit: 'facts|expense_facts|amount', key: JSON.stringify({ ym: '2027-03', category_id: 'c1', item_key: '' }),
    defaults: JSON.stringify({ category_title: 'Жизнь', item_title: '' }), type: 'money',
  }, '2500'), fmt);
  assert.deepEqual(store.state.facts.expense_facts, [{ ym: '2027-03', category_id: 'c1', item_key: '', category_title: 'Жизнь', item_title: '', amount: 2500 }]);
});

test('удаление: зависимые строки уходят вместе, в том числе из других доменов', () => {
  const store = fakeStore({
    savings: {
      goals: [{ id: 'g1' }, { id: 'g2' }],
      goal_milestones: [{ id: 'm1', goal_id: 'g1' }, { id: 'm2', goal_id: 'g2' }],
      goal_transactions: [{ id: 't1', goal_id: 'g1' }],
      goal_cycles: [{ id: 'c1', goal_id: 'g1' }],
      savings_period_overrides: [{ period_id: 'p1', goal_id: 'g1', amount: 5 }],
    },
    gifts: { gift_events: [{ id: 'e1', goal_id: 'g1' }] },
  });
  deleteRow(store, 'savings', 'goals', { id: 'g1' });
  assert.deepEqual(store.state.savings.goals, [{ id: 'g2' }]);
  assert.deepEqual(store.state.savings.goal_milestones, [{ id: 'm2', goal_id: 'g2' }]);
  assert.deepEqual(store.state.savings.goal_transactions, []);
  assert.deepEqual(store.state.savings.goal_cycles, []);
  assert.deepEqual(store.state.savings.savings_period_overrides, []);
  assert.deepEqual(store.state.gifts.gift_events, []);
});

test('удаление выплаты уносит её ручные суммы из всех доменов', () => {
  const store = fakeStore({
    income: { periods: [{ id: 'p1' }, { id: 'p2' }] },
    expenses: { expense_period_overrides: [{ period_id: 'p1', category_id: 'c' }] },
    savings: { savings_period_overrides: [{ period_id: 'p1', goal_id: 'g' }] },
    debts: { credit_payment_overrides: [{ period_id: 'p2', card_id: 'k' }] },
  });
  deleteRow(store, 'income', 'periods', { id: 'p1' });
  assert.deepEqual(store.state.income.periods, [{ id: 'p2' }]);
  assert.deepEqual(store.state.expenses.expense_period_overrides, []);
  assert.deepEqual(store.state.savings.savings_period_overrides, []);
  assert.equal(store.state.debts.credit_payment_overrides.length, 1);
});

test('добавление строки и поиск по составному ключу', () => {
  const store = fakeStore({ income: {} });
  addRow(store, 'income', 'payout_slots', { year: 2027, sort_order: 1, pay_day: 20 });
  assert.equal(findRow(store.state, 'income', 'payout_slots', { year: 2027, sort_order: 1 }).pay_day, 20);
  assert.equal(findRow(store.state, 'income', 'payout_slots', { year: 2027, sort_order: 2 }), null);
});

test('годы плана: учитываются и график без выплат, и пустой план', async () => {
  const { planYears } = await import('../src/ui/app.js');
  assert.deepEqual(planYears({}, '2026-09-21'), [2027]);
  assert.deepEqual(planYears({ income: { plan_years: [{ year: 2028 }] } }, '2026-09-21'), [2028]);
  assert.deepEqual(planYears({ income: {
    periods: [{ year: 2027 }], plan_years: [{ year: 2027 }, { year: 2028 }], payout_slots: [{ year: 2028 }],
  } }, '2026-09-21'), [2027, 2028]);
});

test('перевод между целями: правка одной стороны меняет вторую, удаление уносит обе', async () => {
  const { syncTransfer } = await import('../src/ui/edit.js');
  const state = { savings: { goal_transactions: [
    { id: 'a', goal_id: 'g1', kind: 'transfer_out', amount: 100, date: '2027-01-01', title: 'Перевод', occurrence_key: 'transfer:1' },
    { id: 'b', goal_id: 'g2', kind: 'transfer_in', amount: 100, date: '2027-01-01', title: 'Перевод', occurrence_key: 'transfer:1' },
    { id: 'c', goal_id: 'g1', kind: 'spend', amount: 5, date: '2027-02-01', title: 'Трата' },
  ] } };
  const store = fakeStore(state);
  const key = JSON.stringify({ id: 'a' });
  applyEdit(store, el({ edit: 'savings|goal_transactions|amount', key, type: 'money' }, '250'), fmt);
  syncTransfer(store, state.savings.goal_transactions[0]);
  assert.equal(state.savings.goal_transactions[1].amount, 250);
  applyEdit(store, el({ edit: 'savings|goal_transactions|date', key, type: 'date' }, '2027-03-05'), fmt);
  syncTransfer(store, state.savings.goal_transactions[0]);
  assert.equal(state.savings.goal_transactions[1].date, '2027-03-05');
  deleteRow(store, 'savings', 'goal_transactions', { id: 'b' });
  assert.deepEqual(state.savings.goal_transactions.map(t => t.id), ['c']);
});

test('удаление года уносит его выплаты и их ручные суммы', () => {
  const store = fakeStore({
    income: { plan_years: [{ year: 2027 }, { year: 2028 }], payout_slots: [{ year: 2027, sort_order: 1 }, { year: 2028, sort_order: 1 }],
      periods: [{ id: 'p1', year: 2027 }, { id: 'p2', year: 2028 }] },
    savings: { savings_period_overrides: [{ period_id: 'p1', goal_id: 'g' }, { period_id: 'p2', goal_id: 'g' }] },
    expenses: { expense_period_overrides: [{ period_id: 'p1', category_id: 'c' }] },
    debts: { credit_payment_overrides: [] },
  });
  deleteRow(store, 'income', 'plan_years', { year: 2027 });
  assert.deepEqual(store.state.income.plan_years, [{ year: 2028 }]);
  assert.deepEqual(store.state.income.payout_slots, [{ year: 2028, sort_order: 1 }]);
  assert.deepEqual(store.state.income.periods.map(p => p.id), ['p2']);
  assert.deepEqual(store.state.savings.savings_period_overrides.map(o => o.period_id), ['p2']);
  assert.deepEqual(store.state.expenses.expense_period_overrides, []);
});

test('следующий год плана: пока выплат нет — текущий, дальше — следующий', async () => {
  const { nextPlanYear } = await import('../src/ui/settings.js');
  assert.equal(nextPlanYear({}, '2026-09-21'), 2026);
  assert.equal(nextPlanYear({ income: { plan_years: [{ year: 2026 }] } }, '2026-09-21'), 2027);
  assert.equal(nextPlanYear({ income: { periods: [{ year: 2027 }] } }, '2026-09-21'), 2028);
});

test('правка: одно поле даты праздника пишет день и месяц, разовому — и год', () => {
  const store = fakeStore({ gifts: { gift_events: [
    { id: 'e1', title: 'Мама ДР', day: 1, month: 1, repeat_kind: 'yearly', base_year: 2026 },
    { id: 'e2', title: 'Свадьба', day: 1, month: 1, repeat_kind: 'once', base_year: 2026 },
  ] } });
  applyEdit(store, el({ edit: 'gifts|gift_events|day', key: JSON.stringify({ id: 'e1' }), type: 'monthday' }, '2027-02-16'), fmt);
  applyEdit(store, el({ edit: 'gifts|gift_events|day', key: JSON.stringify({ id: 'e2' }), type: 'monthday' }, '2027-08-06'), fmt);
  const [yearly, once] = store.state.gifts.gift_events;
  assert.deepEqual([yearly.day, yearly.month, yearly.base_year], [16, 2, 2026]);
  assert.deepEqual([once.day, once.month, once.base_year], [6, 8, 2027]);
});
