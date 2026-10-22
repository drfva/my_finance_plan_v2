/* Тесты правки данных из разметки (ui/edit.js) — без браузера */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, deleteRow, addRow, findRow } from '../src/ui/edit.js';
import { createFormat } from '../src/core/format.js';
import { handle as handleGoals, milestoneStatus, goalSummary, goalCard, render as renderGoals, moveGoal } from '../src/ui/goals.js';
import { render as renderReserves } from '../src/ui/reserves.js';
import { render as renderDashboard, handle as handleDashboard } from '../src/ui/dashboard.js';
import { render as renderPeriods, handle as handlePeriods } from '../src/ui/periods.js';
import { calendarCard, handle as handleSettings } from '../src/ui/settings.js';
import { render as renderInstallments } from '../src/ui/installments.js';
import { render as renderGifts } from '../src/ui/gifts.js';
import { simulate, goalProgressAt, goalBalanceAt } from '../src/engine/allocation.js';
import { createConfig } from '../src/core/config.js';
import fs from 'node:fs';

const fmt = createFormat({ locale: 'ru-RU', currency: 'RUB', rounding: 1, currencies: [{ code: 'RUB', symbol: '₽' }] });

function fakeStore(state) {
  return {
    state,
    updates: [],
    update(domain, fn) { this.updates.push(domain); fn(state[domain] ?? (state[domain] = {}), state); },
  };
}
const el = (dataset, value) => ({ dataset, value, checked: value === true });

const click = (action, id) => ({ target: { closest: selector => selector === `[data-${action}]`
  ? { dataset: { [action.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]: id } } : null } });

function goalContext(goals, milestones = []) {
  const state = JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json', import.meta.url), 'utf8'));
  state.income = { periods: [] };
  state.expenses = {};
  state.debts = {};
  state.gifts = {};
  state.savings = { goals, goal_milestones: milestones, goal_transactions: [] };
  const cfg = createConfig(state);
  return { state, cfg, store: fakeStore(state), fmt, canEdit: true, today: '2027-03-01', year: 2027,
    ui: { open: new Set(), draft: { dashboard: { view: 'saved' } } }, sim: simulate(state, cfg, { today: '2027-03-01' }) };
}

test('производственный календарь: месяцы, високосный февраль, свои дни и счётчик рабочих дней', () => {
  const ctx = goalContext([]);
  ctx.ui.open.add('set:calendar');
  ctx.ui.draft.settings = { calendarMonth: '2028-02' };
  let html = calendarCard(ctx);
  assert.equal((html.match(/data-calendar-day=/g) ?? []).length, 29);
  assert.match(html, /2028-02-29/);
  assert.match(html, /Рабочих: 20/);
  assert.doesNotMatch(html, /<table|class="own/);
  assert.equal(handleSettings(click('calendar-month', '2028-12:1'), ctx), true);
  assert.equal(ctx.ui.draft.settings.calendarMonth, '2029-01');
  assert.equal(handleSettings(click('calendar-month', '2029-01:-1'), ctx), true);
  assert.equal(ctx.ui.draft.settings.calendarMonth, '2028-12');
  ctx.ui.draft.settings.calendarMonth = '2028-02';
  assert.equal(handleSettings(click('calendar-day', '2028-02-07'), ctx), true);
  assert.equal(handleSettings(click('calendar-set', '2028-02-07:holiday'), ctx), true);
  const refresh = () => { ctx.sim = simulate(ctx.state, ctx.cfg); };
  refresh();
  html = calendarCard(ctx);
  assert.match(html, /Рабочих: 19/);
  assert.match(html, /По календарю/);
  assert.equal(ctx.sim.income.calendar.day('2028-02-07').working, false);
  handleSettings(click('calendar-set', '2028-02-07:workday'), ctx);
  refresh();
  assert.equal(ctx.sim.income.calendar.day('2028-02-07').working, true);
  handleSettings(click('calendar-set', '2028-02-07:default'), ctx);
  assert.deepEqual(ctx.state.income.account_calendar_days, []);
  const viewer = { ...ctx, canEdit: false };
  assert.doesNotMatch(calendarCard(viewer), /data-calendar-set=/);
  assert.equal(handleSettings(click('calendar-set', '2028-02-07:holiday'), viewer), false);
  assert.equal(handleSettings(click('calendar-set', '2028-02-30:holiday'), ctx), false);
});

test('ручной доход закрепляется вместе с числом и отмечается рамкой; «по формуле» возвращает авто', () => {
  const ctx = goalContext([]);
  ctx.state.income.periods = [{ id: 'p', year: 2027, pay_date: '2027-03-20', window_start: '2027-03-01', window_end: '2027-03-15',
    income_net: 10000, calc_mode: 'auto', income_manual: false }];
  ctx.state.income.salary_rates = [{ id: 'rate', effective_from: '2027-01-01', amount: 100000, is_gross: false }];
  const refresh = () => { ctx.sim = simulate(ctx.state, ctx.cfg); ctx.income = ctx.sim.income; };
  refresh();
  ctx.ui.open.add('period:p');
  applyEdit(ctx.store, el({ edit: 'income|periods|income_net', key: '{"id":"p"}', type: 'money' }, '12345'), fmt);
  assert.equal(ctx.state.income.periods[0].income_manual, true);
  refresh();
  assert.match(renderPeriods(ctx), /class="own num"[^>]*data-edit="income\|periods\|income_net"/);
  assert.equal(ctx.income.byId.get('p').salary, 12345);
  assert.equal(handlePeriods(click('fill-income', 'p'), ctx), true);
  assert.equal(ctx.state.income.periods[0].income_manual, false);
  refresh();
  assert.doesNotMatch(renderPeriods(ctx), /class="own num"[^>]*data-edit="income\|periods\|income_net"/);
  assert.equal(ctx.income.byId.get('p').salary, ctx.income.byId.get('p').formula.net);
});

test('расчётные поля: ручные отпускные, платежи рассрочки и суммы подарков отмечаются', () => {
  const ctx = goalContext([]);
  ctx.state.income.vacations = [{ id: 'v', pay_manual: false, pay_amount: 0 }];
  applyEdit(ctx.store, el({ edit: 'income|vacations|pay_amount', key: '{"id":"v"}', type: 'money' }, '1000'), fmt);
  assert.equal(ctx.state.income.vacations[0].pay_manual, true);
  ctx.state.debts.installments = [{ id: 'i', title: 'Покупка', total: 1000, parts: 2, every_n: 1, period_unit: 'month' }];
  ctx.state.debts.installment_payments = [{ id: 'i-1', installment_id: 'i', pay_date: '2027-04-01', amount: 500 }];
  applyEdit(ctx.store, el({ edit: 'debts|installment_payments|amount', key: '{"id":"i-1"}', type: 'money' }, '700'), fmt);
  assert.deepEqual(ctx.state.debts.installment_payments[0].manual_fields, ['amount']);
  ctx.ui.open.add('inst:i');
  assert.match(renderInstallments(ctx), /class="own num"[^>]*data-edit="debts\|installment_payments\|amount"/);
  ctx.state.gifts = { gift_events: [{ id: 'e', title: 'Праздник', month: 12, day: 23, repeat_kind: 'yearly' }],
    gift_event_amounts: [{ event_id: 'e', year: 2027, amount: 1000 }] };
  assert.match(renderGifts(ctx), /class="own num"[^>]*data-edit="gifts\|gift_event_amounts\|amount"/);
});

test('архив: скрывает только список своего раздела; возврат не открывает цель и не меняет снимок', () => {
  for (const kind of ['bucket', 'reserve']) {
    const goal = { id: 'g', title: 'Архивная цель', kind_code: kind, currency_code: 'RUB', priority: null,
      completed: true, starting_balance: 100, target_amount: 100,
      completion_snapshot: { date: '2027-02-01', progress: 100, phase: { idx: 1, saved: 0 }, milestones: [] } };
    const ctx = goalContext([goal]);
    const render = kind === 'bucket' ? renderGoals : renderReserves;
    assert.match(render(ctx), /value="Архивная цель"/);
    const snapshot = structuredClone(goal.completion_snapshot);
    assert.equal(handleGoals(click('goal-archive', goal.id), ctx), true);
    assert.equal(goal.archived, true);
    assert.doesNotMatch(render(ctx), /value="Архивная цель"/);
    assert.match(renderDashboard(ctx), /Архивная цель/, 'архив остаётся в Обзоре');
    ctx.ui.open.add(`goal-archive:${kind}`);
    const html = render(ctx);
    assert.match(html, /value="Архивная цель"/);
    assert.match(html, /Вернуть из архива/);
    assert.doesNotMatch(html, /приоритет|data-goal-move/);
    assert.equal(handleGoals(click('goal-archive', goal.id), ctx), true);
    assert.equal(goal.archived, false);
    assert.equal(goal.completed, true);
    assert.equal(goal.priority, null);
    assert.deepEqual(goal.completion_snapshot, snapshot);
    assert.match(render(ctx), /Вернуть в работу/);
    goal.archived = true;
    assert.equal(handleGoals(click('goal-close', goal.id), ctx), true);
    assert.equal(goal.completed, false);
    assert.equal(goal.archived, false);
    assert.equal(goal.priority, 1);
    assert.equal(goal.completion_snapshot, null);
  }
});

test('Обзор: глазик скрывает только выбранную цель, вернуть можно даже из архива', () => {
  const goals = ['a', 'b'].map(id => ({ id, title: `Цель ${id}`, kind_code: 'bucket', currency_code: 'RUB',
    priority: null, completed: true, archived: true, target_amount: 100, starting_balance: 0 }));
  const ctx = goalContext(goals);
  assert.match(renderDashboard(ctx), /data-goal-hide-overview="a"/);
  assert.equal(handleDashboard(click('goal-hide-overview', 'a'), ctx), true);
  const html = renderDashboard(ctx);
  assert.doesNotMatch(html, /Цель a/);
  assert.match(html, /Цель b/);
  const restored = JSON.parse(JSON.stringify(ctx.state));
  assert.equal(restored.savings.goals[0].hidden_overview, true, 'видимость хранится вместе с целью');
  ctx.ui.open.add('goal-archive:bucket');
  assert.match(renderGoals(ctx), /Показать на Обзоре/);
  assert.equal(handleGoals(click('goal-show-overview', 'a'), ctx), true);
  assert.match(renderDashboard(ctx), /Цель a/);
  assert.equal(goals[0].archived, true);
  assert.equal(goals[0].completed, true);
  const viewer = { ...ctx, canEdit: false };
  assert.doesNotMatch(renderDashboard(viewer), /data-goal-hide-overview/);
  assert.equal(handleDashboard(click('goal-hide-overview', 'a'), viewer), false);
  assert.equal(handleGoals(click('goal-archive', 'a'), viewer), false);
  assert.equal(handleGoals(click('goal-close', 'a'), viewer), false);
});

test('Обзор: цель видна в годы накопления и закрытия, но не в последующие; архив не заменяет годовой отбор', () => {
  const goal = { id: 'phone', title: 'Айфон', kind_code: 'bucket', currency_code: 'RUB',
    priority: 1, target_amount: 100, deadline: '2027-06-01', starting_balance: 0 };
  const ctx = goalContext([goal]);
  ctx.state.income.periods = [2026, 2027].map(year => ({
    id: `p${year}`, year, pay_date: `${year}-05-20`, calc_mode: 'manual', income_net: 100, locked: true,
  }));
  ctx.state.savings.savings_period_overrides = [
    { period_id: 'p2026', goal_id: goal.id, amount: 40 },
    { period_id: 'p2027', goal_id: goal.id, amount: 60 },
  ];
  const refresh = () => { ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today }); };
  const shown = year => { ctx.year = year; return /data-goal-hide-overview="phone"/.test(renderDashboard(ctx)); };
  refresh();
  assert.equal(shown(2026), true);
  assert.equal(shown(2027), true);
  assert.equal(shown(2028), false, 'автоматически накопленная цель закончилась в 2027');
  Object.assign(goal, { completed: true, archived: true, completion_snapshot: {
    date: '2027-05-20', progress: 100, phase: { idx: 1, saved: 0 }, milestones: [],
  } });
  refresh();
  assert.equal(shown(2026), true);
  assert.equal(shown(2027), true, 'закрытая архивная цель остаётся в своём году');
  assert.equal(shown(2028), false);
  goal.hidden_overview = true;
  assert.equal(shown(2026), false);
  assert.equal(shown(2027), false);
  handleGoals(click('goal-show-overview', goal.id), ctx);
  assert.equal(shown(2027), true);
  assert.equal(shown(2028), false, 'возврат глазиком сохраняет годовой отбор');
  goal.completion_snapshot.date = '2026-12-01';
  assert.equal(shown(2027), false, 'ручное закрытие раньше срока ограничивает год показа');
});

test('Обзор: опаздывающая и незавершённая цель остаётся видимой; у подушки без закрытия сохраняется баланс', () => {
  const goals = [
    { id: 'late', title: 'Поздний прогноз', kind_code: 'bucket', target_amount: 100, deadline: '2027-12-01' },
    { id: 'open', title: 'Без прогноза', kind_code: 'bucket', target_amount: 100, deadline: '2027-12-01' },
    { id: 'reserve', title: 'Подушка', kind_code: 'reserve', target_amount: 100, starting_balance: 100 },
  ].map(g => ({ currency_code: 'RUB', ...g }));
  const ctx = goalContext(goals);
  ctx.sim.milestoneDates.late = ['2028-02-01'];
  ctx.year = 2028;
  const html = renderDashboard(ctx);
  assert.match(html, /data-goal-hide-overview="late"/);
  assert.match(html, /data-goal-hide-overview="open"/);
  assert.match(html, /data-goal-hide-overview="reserve"/);
});

test('переключатель годов: до трёх соседних кнопок, края окна и остальные годы', async () => {
  const { yearWindow } = await import('../src/ui/app.js');
  const three = [2026, 2027, 2028];
  for (const year of three) assert.deepEqual(yearWindow(three, year), { shown: three, past: [], future: [] });
  for (const year of [2026, 2027]) assert.deepEqual(yearWindow([...three, 2029], year), {
    shown: three, past: [], future: [2029],
  });
  for (const year of [2028, 2029]) assert.deepEqual(yearWindow([...three, 2029], year), {
    shown: [2027, 2028, 2029], past: [2026], future: [],
  });
  assert.deepEqual(yearWindow([2025, ...three, 2029], 2027), { shown: three, past: [2025], future: [2029] });
  assert.deepEqual(yearWindow([2030, 2026, 2028], 2028), { shown: [2026, 2028, 2030], past: [], future: [] });
  assert.deepEqual(yearWindow([2027], 2027), { shown: [2027], past: [], future: [] });
  assert.deepEqual(yearWindow([], 2027), { shown: [], past: [], future: [] });
});

test('приоритет: закрытые цели пропускаются стрелками, в архив можно отправить только закрытую', () => {
  const a = { id: 'a', kind_code: 'bucket', priority: 1 };
  const b = { id: 'b', kind_code: 'bucket', priority: null, completed: true };
  const c = { id: 'c', kind_code: 'bucket', priority: 2 };
  const reserve = { id: 'r', kind_code: 'reserve', priority: 1 };
  const ctx = goalContext([a, b, c, reserve]);
  assert.equal(moveGoal(ctx, 'a', 'down'), true);
  assert.deepEqual([a.priority, b.priority, c.priority, reserve.priority], [2, null, 1, 1]);
  assert.equal(moveGoal(ctx, 'b', 'down'), false);
  assert.equal(handleGoals(click('goal-archive', 'a'), ctx), false);
  assert.equal(a.archived, undefined);
});

test('сводка цели: ближайшая будущая дата, предупреждение видно без раскрытия, метки «потрачено» нет', () => {
  const goal = { id: 'g', title: 'Этапы', kind_code: 'bucket', priority: 1, currency_code: 'RUB', target_amount: 0 };
  const ms = [
    { id: 'old', goal_id: 'g', title: 'Старый', target: 100, deadline: '2027-01-01' },
    { id: 'late', goal_id: 'g', title: 'Опаздывает', target: 100, deadline: '2027-02-01' },
    { id: 'next', goal_id: 'g', title: 'Ближайший', target: 100, deadline: '2027-04-01' },
    { id: 'later', goal_id: 'g', title: 'Дальний', target: 100, deadline: '2027-10-01' },
  ];
  const ctx = goalContext([goal], ms);
  ctx.sim.milestoneDates.g = ['2027-01-01', '2027-07-01', '2027-08-01', '2027-11-01'];
  ctx.sim.milestoneFunded.g = [0, 0, 100, 100];
  assert.equal(goalSummary(ctx, goal).next.m.id, 'next', 'прошлые даты пропущены, ближайший срок раньше прогноза');
  const html = goalCard(ctx, goal);
  assert.match(html, /goal-late/);
  assert.match(html, /Есть этапы позже срока/);
  assert.match(html, /Ближайший: позже срока/);
  assert.doesNotMatch(html, /потрачено/);
  assert.doesNotMatch(milestoneStatus(ctx, goal, ms[0]).label, /потрачено/);
  ctx.sim.milestoneDates.g[1] = '2027-03-05';
  assert.equal(goalSummary(ctx, goal).next.m.id, 'late', 'ближайший будущий прогноз тоже учитывается');
  ctx.today = '2028-01-01';
  assert.equal(goalSummary(ctx, goal).next, null, 'не возвращаемся к первому этапу, если будущих нет');
});

test('закрытие цели сохраняет сегодняшнее пополнение и прогресс после перезагрузки; возврат снимает фиксацию', () => {
  const state = JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json', import.meta.url), 'utf8'));
  const g = { id: 'closed-test', title: 'Цель', kind_code: 'bucket', currency_code: 'RUB',
    target_amount: 200, starting_balance: 0, priority: 1, completed: false };
  const periods = [
    { id: 'today', year: 2027, pay_date: '2027-03-01', window_start: '2027-03-01', window_end: '2027-03-15', income_net: 100 },
    { id: 'future', year: 2027, pay_date: '2027-03-20', window_start: '2027-03-16', window_end: '2027-03-31', income_net: 100 },
  ];
  state.income = { periods };
  state.expenses = {};
  state.debts = {};
  state.savings = { goals: [g], goal_milestones: [
    { id: 'm1', goal_id: g.id, target: 100, deadline: '2027-06-01' },
    { id: 'm2', goal_id: g.id, target: 100, deadline: '2027-07-01' },
  ], goal_transactions: [] };
  const store = fakeStore(state);
  const run = () => simulate(state, createConfig(state), { today: '2027-03-01' });
  const ctx = { store, state, canEdit: true, ui: {}, today: '2027-03-01', sim: run() };
  const ev = { target: { closest: selector => selector === '[data-goal-close]' ? { dataset: { goalClose: g.id } } : null } };
  assert.equal(goalProgressAt(ctx.sim, g, '2027-03-20'), 200, 'до закрытия есть будущий прогноз');
  assert.equal(handleGoals(ev, ctx), true);
  assert.equal(g.completed, true);
  assert.equal(g.priority, null);
  assert.equal(g.completion_snapshot.progress, 100, 'засчитано только накопленное на сегодня');
  assert.equal(state.savings.savings_period_overrides[0].amount, 100);
  state.savings.goal_transactions.push({ id: 'out', goal_id: g.id, date: ctx.today, kind: 'transfer_out', amount: 100 });
  const restored = JSON.parse(JSON.stringify(state));
  const sim = simulate(restored, createConfig(restored), { today: '2027-03-01' });
  assert.equal(goalProgressAt(sim, restored.savings.goals[0], ctx.today), 100);
  assert.equal(goalBalanceAt(sim, g, restored.savings.goal_transactions, ctx.today), 0);
  assert.equal(sim.byId.get('today').allocations[g.id], 100, 'закрытие не убирает сегодняшнее отчисление');
  assert.equal(sim.byId.get('future').allocations[g.id], undefined);
  assert.equal(milestoneStatus({ sim, fmt }, restored.savings.goals[0], state.savings.goal_milestones[0]).cls, 'ok');
  assert.equal(milestoneStatus({ sim, fmt }, restored.savings.goals[0], state.savings.goal_milestones[1]).done, null);
  ctx.sim = run();
  assert.equal(handleGoals(ev, ctx), true);
  assert.equal(g.completed, false);
  assert.equal(g.priority, 1);
  assert.equal(g.completion_snapshot, null);
  assert.ok(run().byId.get('future').allocations[g.id] > 0, 'открытая снова цель получает деньги');
});

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

test('правка: этап из шаблона закрепляется, генератор его больше не трогает', () => {
  const store = fakeStore({ savings: {
    goal_milestones: [{ id: 'cyc:c1:2027-06-01', goal_id: 'g', target: 15000, source: 'cycle', user_edited: false },
      { id: 'ms-hand', goal_id: 'g', target: 100, source: 'manual', user_edited: false }],
    goal_transactions: [{ id: 'cyc:c1:2027-06-01:spend', goal_id: 'g', milestone_id: 'cyc:c1:2027-06-01', amount: 15000, source: 'cycle', user_edited: false }],
  } });
  applyEdit(store, el({ edit: 'savings|goal_milestones|target', key: JSON.stringify({ id: 'cyc:c1:2027-06-01' }), type: 'money' }, '22000'), fmt);
  assert.equal(store.state.savings.goal_milestones[0].user_edited, true);
  applyEdit(store, el({ edit: 'savings|goal_transactions|amount', key: JSON.stringify({ id: 'cyc:c1:2027-06-01:spend' }), type: 'money' }, '9000'), fmt);
  assert.equal(store.state.savings.goal_transactions[0].user_edited, true);
  // ручная строка признак не получает — ей он не нужен
  applyEdit(store, el({ edit: 'savings|goal_milestones|target', key: JSON.stringify({ id: 'ms-hand' }), type: 'money' }, '200'), fmt);
  assert.equal(store.state.savings.goal_milestones[1].user_edited, false);
});

test('подсказки первого входа: показываются пустому плану и знают выполненные шаги', async () => {
  const { tourNeeded, tourPanel } = await import('../src/ui/tour.js');
  const empty = {
    canEdit: true,
    state: { account: { id: 'a', title: 'Мой план', role: 'owner' }, accounts: [{ id: 'a', title: 'Мой план', role: 'owner' }], income: {} },
    ui: { draft: {}, open: new Set(), tab: 'dashboard' },
  };
  assert.equal(tourNeeded(empty), true);
  const html = tourPanel(empty);
  assert.match(html, /Шаг 1 из 6/);
  assert.match(html, /Это ваш план/);

  // есть график выплат — подсказки больше не нужны
  const filled = { ...empty, state: { ...empty.state, income: { payout_slots: [{ year: 2027, sort_order: 1 }] } } };
  assert.equal(tourNeeded(filled), false);

  // оклад внесён — подсказка сама встаёт на следующий невыполненный шаг
  const started = { ...empty, ui: { draft: {}, open: new Set(), tab: 'dashboard' },
    state: { ...empty.state, income: { salary_rates: [{ id: 'r', amount: 100000 }] } } };
  assert.match(tourPanel(started), /Проверьте налог/);

  // читателю чужого плана подсказки про настройку не показываем
  assert.equal(tourNeeded({ ...empty, canEdit: false }), false);
});
