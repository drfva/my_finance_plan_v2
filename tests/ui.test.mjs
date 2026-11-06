/* Тесты правки данных из разметки (ui/edit.js) — без браузера */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, deleteRow, addRow, findRow, attachEditing } from '../src/ui/edit.js';
import { createFormat } from '../src/core/format.js';
import { handle as handleGoals, milestoneStatus, goalSummary, goalCard, render as renderGoals, moveGoal } from '../src/ui/goals.js';
import { render as renderReserves } from '../src/ui/reserves.js';
import { render as renderDashboard, handle as handleDashboard } from '../src/ui/dashboard.js';
import { render as renderPeriods, handle as handlePeriods } from '../src/ui/periods.js';
import { calendarCard, handle as handleSettings, render as renderSettings, attachSettings } from '../src/ui/settings.js';
import { render as renderCredits } from '../src/ui/credits.js';
import { render as renderCategories, handle as handleCategories, handleChange as changeCategories } from '../src/ui/categories.js';
import { yearOptions as vacationYears } from '../src/ui/vacations.js';
import { yearOptions as sickYears } from '../src/ui/sick.js';
import { fatalPage } from '../src/ui/fatal.js';
import { scrollToPending } from '../src/ui/navigation.js';
import { tourHandle } from '../src/ui/tour.js';
import { render as renderInstallments } from '../src/ui/installments.js';
import { render as renderGifts } from '../src/ui/gifts.js';
import { render as renderVacations } from '../src/ui/vacations.js';
import { renderSick } from '../src/ui/sick.js';
import { render as renderFacts } from '../src/ui/facts.js';
import { inSeasonMonth } from '../src/engine/expenses.js';
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

test('валютная копилка: Обзор показывает взнос в валюте цели, карточка — курс и дату', () => {
  const ctx = goalContext([{ id:'usd', title:'Доллары', kind_code:'bucket', currency_code:'USD', target_amount:1000 }]);
  ctx.state.income.periods = [{ id:'p', year:2027, pay_date:'2027-03-20', window_start:'2027-03-01', window_end:'2027-03-20', calc_mode:'manual', income_net:5000 }];
  ctx.state.settings.fx_rates = [{ base_code:'RUB', quote_code:'USD', rate_date:'2027-03-01', rate:100 }];
  ctx.sim = simulate(ctx.state, ctx.cfg, { today:ctx.today });
  const html = renderDashboard(ctx);
  assert.ok(html.includes(fmt.money(50, 'USD')));
  assert.ok(!html.includes(fmt.money(5000, 'USD')));
  const detail = goalCard(ctx, ctx.state.savings.goals[0]);
  assert.match(detail, /Курс для прогноза: 1 USD = 100 RUB на 01.03.2027/);
  ctx.state.current_fx = { error:true };
  assert.match(goalCard(ctx, ctx.state.savings.goals[0]), /Не удалось обновить курс/);
});

test('Обзор расходов: статьи и средние за 12 месяцев без двойного суммирования',()=>{
  const ctx=goalContext([]);ctx.ui.draft.dashboard.view='expenses';
  ctx.state.expenses={expense_categories:[{id:'life',title:'Жизнь',mode:'fixed_month',monthly_amount:12000}],expense_items:[{id:'food',category_id:'life',title:'Продукты',amount:9000},{id:'bus',category_id:'life',title:'Транспорт',amount:3000}]};
  ctx.state.facts={expense_facts:[{category_id:'life',item_key:'food',ym:'2027-01',amount:6000}]};
  ctx.sim.rows=[{period:{pay_date:'2027-01-20',year:2027},expenses:{categories:[{category_id:'life',amount:12000}]},categoriesTotal:12000,installmentsTotal:0,debtPayments:{},installments:[],savings:{},income:{total:12000}}];
  const html=renderDashboard(ctx);
  assert.match(html,/План в среднем за месяц/);assert.match(html,/Факт в среднем за месяц/);
  assert.match(html,/Продукты/);assert.match(html,/Транспорт/);
  assert.ok(html.includes(fmt.money(750)));assert.ok(html.includes(fmt.money(250)));assert.ok(html.includes(fmt.money(500)));
});

test('Обзор расходов: рассрочки и кредитки показаны общими годовыми суммами',()=>{
  const ctx=goalContext([]);ctx.ui.draft.dashboard.view='expenses';
  ctx.state.debts={installments:[{id:'i1',title:'Телефон'},{id:'i2',title:'Ноутбук'}],credit_cards:[{id:'c1',title:'Карта А'},{id:'c2',title:'Карта Б'}]};
  ctx.sim.rows=[{period:{pay_date:'2027-01-20',year:2027},expenses:{categories:[]},categoriesTotal:0,
    installmentsTotal:3000,debtPayments:{c1:1200,c2:800},installments:[],savings:{},income:{total:10000}}];
  const html=renderDashboard(ctx);
  assert.match(html,/Рассрочки/);assert.match(html,/Кредитки/);
  assert.doesNotMatch(html,/Телефон|Ноутбук|Карта А|Карта Б/);
  for(const value of [3000,2000,5000])assert.ok(html.includes(fmt.money(value)));
});

test('повторная правка значения не пишет данные и не закрепляет автоматически созданную строку',()=>{
  const store=fakeStore({savings:{goals:[{id:'g',deadline:null}],goal_milestones:[{id:'m',target:2000,title:'Отпуск',source:'cycle',user_edited:false}]},
    income:{periods:[{id:'p',income_net:1000,income_manual:false}]}});
  assert.equal(applyEdit(store,el({edit:'savings|goals|deadline',key:'{"id":"g"}',type:'date'},''),fmt),null);
  for(const [column,value,type] of [['target','2 000','money'],['title','Отпуск','text']])
    assert.equal(applyEdit(store,el({edit:`savings|goal_milestones|${column}`,key:'{"id":"m"}',type},value),fmt),null);
  assert.equal(applyEdit(store,el({edit:'income|periods|income_net',key:'{"id":"p"}',type:'money'},'1000'),fmt),null);
  assert.deepEqual(store.updates,[]);
  assert.equal(store.state.savings.goal_milestones[0].user_edited,false);
  assert.equal(store.state.income.periods[0].income_manual,false);
  const suggested={...el({edit:'savings|savings_period_overrides|amount',key:'{"period_id":"p","goal_id":"g"}',type:'money'},'500'),defaultValue:'500'};
  assert.equal(applyEdit(store,suggested,fmt),null);
  assert.equal(store.state.savings.savings_period_overrides,undefined);
});

test('валюта целей: значки вместо списка, выбор и запрет редактирования читателю',()=>{
  const goal={id:'currency-goal',title:'Покупка',kind_code:'bucket',currency_code:'RUB',target_amount:1000,starting_balance:100,completed:false};
  const reserve={...goal,id:'currency-reserve',kind_code:'reserve'};
  const ctx=goalContext([goal,reserve]);
  ctx.state.ref.currencies.push({code:'USD',symbol:'$',sort_order:2});ctx.cfg=createConfig(ctx.state);
  let html=goalCard(ctx,goal);
  assert.doesNotMatch(html,/data-edit="savings\|goals\|currency_code"/);
  assert.match(html,/data-goal-currency-toggle="currency-goal"/);
  handleGoals(click('goal-currency-toggle',goal.id),ctx);
  assert.match(goalCard(ctx,goal),/data-currency="USD"/);
  handleGoals(click('goal-currency-toggle',reserve.id),ctx);
  assert.equal(ctx.ui.open.has('goal-currency:currency-goal'),false);
  assert.match(renderReserves(ctx),/goal-currency-options/);
  const choose=code=>({target:{closest:s=>s==='[data-goal-currency]'?{dataset:{goalCurrency:reserve.id,currency:code}}:null}});
  assert.equal(handleGoals(choose('USD'),ctx),true);
  assert.equal(reserve.currency_code,'USD');assert.equal(reserve.target_amount,1000);assert.equal(reserve.starting_balance,100);
  assert.equal(ctx.ui.open.has(`goal-currency:${reserve.id}`),false);
  assert.equal(handleGoals(choose('UNKNOWN'),ctx),false);
  ctx.canEdit=false;assert.equal(handleGoals(click('goal-currency-toggle',goal.id),ctx),false);
  assert.match(goalCard(ctx,goal),/goal-currency-toggle[^>]* disabled/);
});

test('свёрнутая выплата: долги включают кредитки и рассрочки, в том числе без кредиток', () => {
  const ctx = goalContext([]);
  ctx.state.income.periods = [{ id: 'p', year: 2027, pay_date: '2027-04-05', calc_mode: 'manual', income_net: 1000 }];
  ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today });
  const row = ctx.sim.byId.get('p');
  row.debtPayments = { card: 200 };
  row.installmentsTotal = 300;
  assert.ok(renderPeriods(ctx).includes(`долги ${fmt.money(500)}`));
  row.debtPayments = {};
  assert.ok(renderPeriods(ctx).includes(`долги ${fmt.money(300)}`));
});

test('прошлые выплаты: якорь на ближайшей скрытой выплате, история остаётся по возрастанию дат', () => {
  const ctx = goalContext([]);
  ctx.today = '2027-03-21';
  ctx.state.income.periods = ['01-05', '02-05', '03-05', '03-20', '04-05'].map((date, i) => ({
    id: `p${i}`, year: 2027, pay_date: `2027-${date}`, calc_mode: 'manual', income_net: 1000,
  }));
  ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today });
  assert.doesNotMatch(renderPeriods(ctx), /data-past-anchor/);
  ctx.ui.open.add('past');
  const html = renderPeriods(ctx);
  assert.equal((html.match(/data-past-anchor/g) ?? []).length, 1);
  assert.match(html, /data-past-anchor tabindex="-1">\s*<div class="period-head" data-toggle="period:p2"/);
  assert.ok(html.indexOf('period:p0') < html.indexOf('period:p2'));
  assert.ok(html.indexOf('period:p2') < html.indexOf('period:p3'));
});

test('отпуска и больничные: прошедшие скрыты, текущие и будущие видны, раскрытие сохраняет записи', () => {
  const ctx = goalContext([]);
  const dates = [
    { id: 'old', start_date: '2027-02-01', end_date: '2027-02-07' },
    { id: 'current', start_date: '2027-02-28', end_date: ctx.today },
    { id: 'future', start_date: '2027-04-01', end_date: '2027-04-07' },
  ];
  ctx.state.income.vacations = dates.map(d => ({ ...d, title: `Отпуск ${d.id}`, pay_manual: true, pay_amount: 1000 }));
  ctx.state.income.sick_leaves = dates.map(d => ({ ...d, note: `Больничный ${d.id}`, benefit_enabled: false }));
  ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today });
  ctx.income = ctx.sim.income;
  const before = JSON.stringify(ctx.state);
  for (const [render, toggle, prefix] of [[renderVacations, 'vacations-past', 'Отпуск'], [renderSick, 'sick-past', 'Больничный']]) {
    let html = render(ctx);
    assert.doesNotMatch(html, new RegExp(`${prefix} old`));
    assert.match(html, new RegExp(`${prefix} current`));
    assert.match(html, new RegExp(`${prefix} future`));
    assert.match(html, new RegExp(`data-toggle="${toggle}"`));
    ctx.ui.open.add(toggle);
    html = render(ctx);
    assert.match(html, new RegExp(`${prefix} old`));
  }
  assert.equal(JSON.stringify(ctx.state), before);
});

test('подушка: действие в меню переключает видимость, читателю недоступно', () => {
  const goal = { id: 'r', title: 'Резерв', kind_code: 'reserve', currency_code: 'RUB', target_amount: 1000, priority: 1 };
  const ctx = goalContext([goal]);
  assert.doesNotMatch(renderReserves(ctx), /data-goal-toggle-overview/);
  ctx.ui.open.add('goal-menu:r');
  assert.match(renderReserves(ctx), /data-goal-toggle-overview="r"[^>]*>Скрыть с Обзора/);
  handleGoals(click('goal-toggle-overview', 'r'), ctx);
  const html = renderReserves(ctx);
  assert.match(html, /data-goal-toggle-overview="r"[^>]*>Вернуть в Обзор/);
  assert.doesNotMatch(renderDashboard(ctx), /<h3>Резерв<\/h3>/);
  const viewer = { ...ctx, canEdit: false };
  assert.doesNotMatch(renderReserves(viewer), /data-goal-toggle-overview/);
  assert.equal(handleGoals(click('goal-toggle-overview', 'r'), viewer), false);
  assert.equal(goal.hidden_overview, true);
  handleGoals(click('goal-toggle-overview', 'r'), ctx);
  assert.match(renderDashboard(ctx), /<h3>Резерв<\/h3>/);
});

test('Расходы: сезонные категории и статьи видны только в подходящем месяце; факт сохраняется', () => {
  assert.equal(inSeasonMonth('2027-01', '12-20', '02-05'), true);
  assert.equal(inSeasonMonth('2027-03', '12-20', '02-05'), false);
  assert.equal(inSeasonMonth('2028-02', '02-29', '02-29'), true);
  assert.equal(inSeasonMonth('2027-02', '02-29', '02-29'), false);
  const ctx = goalContext([]);
  ctx.ui.draft.facts = { month: '2027-03' };
  ctx.state.expenses = {
    expense_categories: [
      { id: 'winter', title: 'Зимний расход', season_from: '12-01', season_to: '02-28' },
      { id: 'items', title: 'Смешанный расход' },
      { id: 'summer', title: 'Летний расход' },
    ],
    expense_items: [
      { id: 'ski', category_id: 'items', title: 'Лыжи', season_from: '12-01', season_to: '02-28' },
      { id: 'partial', category_id: 'items', title: 'Конец марта', season_from: '03-31', season_to: '04-02' },
      { id: 'boat', category_id: 'summer', title: 'Лодка', season_from: '06-01', season_to: '08-31' },
    ],
  };
  ctx.state.facts = { expense_facts: [{ ym: '2027-03', category_id: 'winter', item_key: '', amount: 99 }] };
  const before = JSON.stringify(ctx.state.facts);
  let html = renderFacts(ctx);
  assert.doesNotMatch(html, /Зимний расход|Летний расход|Лыжи|Лодка/);
  assert.match(html, /Смешанный расход|Конец марта/);
  assert.ok(html.includes(`${fmt.money(99)}</b>`), 'сумма факта не исчезает из итогов');
  assert.equal(JSON.stringify(ctx.state.facts), before);
  ctx.ui.draft.facts.month = '2027-01';
  html = renderFacts(ctx);
  assert.match(html, /Зимний расход/);
  assert.match(html, /Лыжи/);
  assert.doesNotMatch(html, /Конец марта|Лодка/);
});

test('производственный календарь: месяцы, високосный февраль, свои дни и счётчик рабочих дней', () => {
  const ctx = goalContext([]);
  ctx.ui.open.add('set:calendar');
  ctx.ui.draft.settings = { calendarMonth: '2028-02' };
  let html = calendarCard(ctx);
  assert.equal((html.match(/data-calendar-day=/g) ?? []).length, 29);
  assert.match(html, /2028-02-29/);
  assert.match(html, /Рабочих: 20/);
  assert.doesNotMatch(html, /working_day_overrides/);
  assert.match(html, /data-toggle="calendar-picker" aria-expanded="false"/);
  assert.doesNotMatch(html, /data-calendar-picker="year"/);
  ctx.ui.open.add('calendar-picker');
  html = calendarCard(ctx);
  assert.match(html, /data-calendar-picker="year"/);
  assert.equal((html.match(/data-calendar-jump=/g) ?? []).length,12);
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
  assert.match(html, /Сделать рабочим/);
  assert.doesNotMatch(html, /Сделать нерабочим/);
  assert.match(html, /По календарю/);
  assert.equal(ctx.sim.income.calendar.day('2028-02-07').working, false);
  handleSettings(click('calendar-set', '2028-02-07:workday'), ctx);
  refresh();
  assert.equal(ctx.sim.income.calendar.day('2028-02-07').working, true);
  assert.match(calendarCard(ctx), /Сделать нерабочим/);
  assert.doesNotMatch(calendarCard(ctx), /Сделать рабочим/);
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

test('создание разовой выплаты: введённая сумма без формулы оклада и без отпускных', () => {
  const ctx = goalContext([]);
  Object.assign(ctx, { today: '2026-10-30', year: 2026 });
  ctx.state.income.periods = [{ id: 'salary', year: 2026, slot_order: 2, calc_mode: 'auto', income_manual: false,
    pay_date: '2026-11-05', window_start: '2026-10-16', window_end: '2026-10-31' }];
  ctx.state.income.salary_rates = [{ id: 'rate', effective_from: '2026-01-01', amount: 230000, is_gross: true }];
  ctx.state.income.vacations = [{ id: 'v', start_date: '2026-10-19', end_date: '2026-10-25', pay_manual: true, pay_amount: 47660 }];
  ctx.ui.draft.periods = { pay_date: '2026-10-18', window: '2026-10', income_net: '2000', kind: 'side_job', taxable: false, note: 'ZELRUN' };
  assert.equal(handlePeriods(click('add-manual', ''), ctx), true);
  const p = ctx.state.income.periods.find(p => p.calc_mode === 'manual');
  assert.equal(p.income_net, 2000);
  assert.equal(p.locked, true);
  ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today });
  ctx.income = ctx.sim.income;
  ctx.ui.open.add(`period:${p.id}`);
  ctx.ui.open.add('past');
  assert.equal(ctx.sim.byId.get(p.id).totalIncome, 2000);
  assert.equal(ctx.sim.byId.get(p.id).income.vacationPay, 0);
  const html = renderPeriods(ctx);
  assert.doesNotMatch(html, new RegExp(`data-fill-income="${p.id}"`));
  assert.doesNotMatch(html, /по формуле:/);
  assert.match(html, /Разовая выплата: используется введённая сумма/);
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
    ctx.ui.open.add('goal-menu:g');
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
  assert.doesNotMatch(renderDashboard(ctx), /data-goal-hide-overview/);
  ctx.ui.open.add('goal-archive:bucket');
  ctx.ui.open.add('goal-menu:a');
  assert.match(renderGoals(ctx), /data-goal-toggle-overview="a"/);
  assert.equal(handleGoals(click('goal-toggle-overview', 'a'), ctx), true);
  const html = renderDashboard(ctx);
  assert.doesNotMatch(html, /Цель a/);
  assert.match(html, /Цель b/);
  const restored = JSON.parse(JSON.stringify(ctx.state));
  assert.equal(restored.savings.goals[0].hidden_overview, true, 'видимость хранится вместе с целью');
  ctx.ui.open.add('goal-archive:bucket');
  assert.match(renderGoals(ctx), /Вернуть в Обзор/);
  assert.equal(handleGoals(click('goal-toggle-overview', 'a'), ctx), true);
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
  const shown = year => { ctx.year = year; return /<h3>Айфон<\/h3>/.test(renderDashboard(ctx)); };
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
  assert.match(html, /<h3>Поздний прогноз<\/h3>/);
  assert.match(html, /<h3>Без прогноза<\/h3>/);
  assert.match(html, /<h3>Подушка<\/h3>/);
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
  assert.match(html, /value="Ближайший"/);
  assert.match(html, /позже срока \(к 01.08.2027\)/);
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

test('ошибка запуска не раскрывает ответы сервера, адрес базы, SQL и разметку ошибки', () => {
  for (const stage of ['auth', 'load', '<img src=x onerror=alert(1)> SQL secret-token https://db.example']) {
    const html = fatalPage(stage);
    assert.match(html, /role="alert"/);
    assert.match(html, /id="retry"/);
    assert.doesNotMatch(html, /SQL|Supabase|config\.js|https:|secret|onerror|<img/);
  }
});

test('отпуска и больничные: фильтр по году начала, переходящие даты не дублируются', () => {
  const ctx = goalContext([]);
  ctx.years = [2027];
  ctx.today = '2028-02-01';
  ctx.state.income.vacations = [
    { id: 'cross', title: 'Переходящий отпуск', start_date: '2027-12-30', end_date: '2028-01-05' },
    { id: 'next', title: 'Отпуск нового года', start_date: '2028-03-01', end_date: '2028-03-10' },
  ];
  ctx.state.income.sick_leaves = [
    { id: 'scross', note: 'Переходящий лист', start_date: '2027-12-30', end_date: '2028-01-05', benefit_enabled: false },
    { id: 'snext', note: 'Лист нового года', start_date: '2028-03-01', end_date: '2028-03-10', benefit_enabled: false },
  ];
  ctx.sim = simulate(ctx.state, ctx.cfg); ctx.income = ctx.sim.income;
  assert.deepEqual(vacationYears(ctx), [2027, 2028]);
  assert.deepEqual(sickYears(ctx), [2027, 2028]);
  ctx.ui.open.add('vacations-past'); ctx.ui.open.add('sick-past');
  for (const [year, present, absent] of [[2027, 'Переходящий', 'нового года'], [2028, 'нового года', 'Переходящий']]) {
    ctx.year = year;
    for (const render of [renderVacations, renderSick]) {
      assert.ok(render(ctx).includes(present));
      assert.ok(!render(ctx).includes(absent));
    }
  }
  ctx.year = 2027; ctx.ui.open.clear();
  assert.doesNotMatch(renderVacations(ctx), /value="Переходящий отпуск"/);
  assert.doesNotMatch(renderSick(ctx), /Переходящий лист/);
});

test('годы графика независимы: в свёрнутом виде счётчик и действия, раскрытие только своего года', () => {
  const ctx = goalContext([]); ctx.years = [2027, 2028]; ctx.income = ctx.sim.income;
  ctx.ui.open.add('set:years');
  ctx.state.income.plan_years = [{ year: 2027 }, { year: 2028 }];
  ctx.state.income.payout_slots = [2027, 2028].map(year => ({ year, sort_order: 1, title: `Выплата-${year}`, pay_day: 20 }));
  let html = renderSettings(ctx);
  assert.match(html, /1 выплата в месяц · 0 в плане/);
  assert.match(html, /data-add="income\|payout_slots"/);
  assert.match(html, /data-del="income\|plan_years"/);
  assert.doesNotMatch(html, /data-edit="income\|payout_slots/);
  ctx.ui.open.add('set:year:2028'); html = renderSettings(ctx);
  assert.match(html, /value="Выплата-2028"/);
  assert.doesNotMatch(html, /value="Выплата-2027"/);
  assert.doesNotMatch(renderCredits(ctx), /early_repayment|Как гасим/);
  ctx.ui.open.add('set:stages');
  assert.match(renderSettings(ctx), /early_repayment/);
});

test('пикер календаря: год выбирается внутри, месяц применяется по нажатию и закрывает пикер', () => {
  const ctx = goalContext([]); ctx.ui.draft.settings = { calendarMonth: '2028-02' };
  const listeners = {}; let renders = 0;
  const root = { addEventListener(type, fn) { listeners[type] = fn; }, querySelector: () => ({ dataset: { calendarDay: `${ctx.ui.draft.settings.calendarMonth}-01` } }) };
  attachSettings(root, ctx.store, () => ctx, () => renders++);
  const change = (part, value) => listeners.change({ target: { matches: s => s === '[data-calendar-picker]', dataset: { calendarPicker: part }, value } });
  ctx.ui.open.add('calendar-picker');
  change('year', '2031'); assert.equal(ctx.ui.draft.settings.calendarPickerYear, 2031);
  assert.equal(ctx.ui.draft.settings.calendarMonth, '2028-02');
  assert.equal(handleSettings(click('calendar-jump','2031-12'),ctx),true);
  assert.equal(ctx.ui.draft.settings.calendarMonth,'2031-12');
  assert.ok(!ctx.ui.open.has('calendar-picker'));
  change('year','10000'); assert.equal(ctx.ui.draft.settings.calendarPickerYear,2031);
  assert.equal(renders, 1);
});

test('мастер первого входа просит прокрутку к открытому блоку; запрос исполняется один раз', () => {
  const ctx = goalContext([]);
  for (const [index, section] of [[1, 'set:salary'], [2, 'set:tax']]) {
    assert.equal(tourHandle(click('tour', `go:${index}`), ctx), true);
    assert.equal(ctx.ui.tab, 'settings'); assert.ok(ctx.ui.open.has(section));
    assert.deepEqual(ctx.ui.scrollTarget, { section });
    let scrolled = 0, focused = 0;
    const element = { getAttribute: () => section, querySelector: () => ({ focus: () => focused++ }), scrollIntoView: options => { assert.equal(options.block, 'start'); scrolled++; } };
    const root = { querySelectorAll: () => [element], querySelector: () => ({ getBoundingClientRect: () => ({ height: 180 }) }), style: { setProperty() {} } };
    scrollToPending(root, ctx.ui); scrollToPending(root, ctx.ui);
    assert.equal(scrolled, 1); assert.equal(focused, 1); assert.equal(ctx.ui.scrollTarget, null);
  }
});

test('новый этап и трата раскрываются до синхронной перерисовки и получают якорь в списке', () => {
  const goal = { id: 'g', title: 'Цель', kind_code: 'bucket', target_amount: 0, currency_code: 'RUB' };
  const ctx = goalContext([goal]); const listeners = {};
  const container = { addEventListener(type, fn) { listeners[type] = fn; } };
  attachEditing(container, ctx.store, () => ctx, e => { throw e; });
  for (const [table, section, date] of [['goal_milestones', 'goal:g', null], ['goal_transactions', 'goal-tx:g', '2027-02-01']]) {
    const row = { id: table, goal_id: 'g', title: 'Новая запись', target: 0, deadline: null, date, kind: 'spend', amount: 0 };
    const original = ctx.store.update;
    ctx.store.update = (domain, fn) => {
      assert.ok(ctx.ui.open.has(section)); assert.deepEqual(ctx.ui.scrollTarget, { row: table });
      original.call(ctx.store, domain, fn);
    };
    listeners.click({ target: { closest: s => s === '[data-add]' ? { dataset: { add: `savings|${table}`, row: JSON.stringify(row) } } : null } });
    ctx.store.update = original;
    if (date) assert.ok(ctx.ui.open.has('tx-hist:g'));
    ctx.sim = simulate(ctx.state, ctx.cfg);
    assert.ok(goalCard(ctx, goal).includes(`data-scroll-row="${table}"`));
  }
});

test('дата отпускных находится рядом с суммой в поле дохода, дублирующей строки нет', () => {
  const ctx = goalContext([]);
  ctx.state.income.periods = [{ id: 'p', year: 2027, pay_date: '2027-03-20', calc_mode: 'auto', income_net: 0,
    window_start: '2027-03-01', window_end: '2027-03-15' }];
  ctx.state.income.salary_rates = [{ id: 'r', effective_from: '2027-01-01', amount: 100000, is_gross: true }];
  ctx.state.income.vacations = [{ id: 'v', title: 'Отпуск', start_date: '2027-03-01', end_date: '2027-03-07', pay_manual: true, pay_amount: 10000 }];
  ctx.sim = simulate(ctx.state, ctx.cfg); ctx.income = ctx.sim.income; ctx.ui.open.add('period:p');
  const html = renderPeriods(ctx);
  const date = ctx.income.vacations[0].payDate;
  assert.ok(html.includes(`фактическая выплата ${fmt.date(date)}`));
  assert.doesNotMatch(html, /Отпускные в этой выплате|В поле — сумма/);
});

function categoryContext() {
  const ctx = goalContext([]);
  ctx.state.expenses = {
    expense_categories: [
      { id: 'life', title: 'Жизнь', mode: 'fixed_month', monthly_amount: 999, split_mode: 'by_days', sort_order: 1 },
      { id: 'joy', title: 'Радости', mode: 'percent_income', monthly_amount: 2000, percent_value: 25, split_mode: 'even', sort_order: 5 },
      { id: 'winter', title: 'Зимний спорт', mode: 'fixed_month', monthly_amount: 3000, season_from: '12-01', season_to: '02-28', sort_order: 6 },
    ],
    expense_items: [
      { id: 'food', category_id: 'life', title: 'Продукты', amount: 4000, sort_order: 1 },
      { id: 'taxi', category_id: 'life', title: 'Транспорт', amount: 2000, sort_order: 7 },
      { id: 'skis', category_id: 'life', title: 'Лыжи', amount: 1000, season_from: '12-01', season_to: '02-28', sort_order: 8 },
    ],
  };
  ctx.ui.tab = 'categories';
  return ctx;
}

test('категории списком: сводка видна без полей, процент и суммы учитывают статьи и сезон', () => {
  const ctx = categoryContext();
  const html = renderCategories(ctx);
  assert.match(html, /data-toggle="cat:life" aria-expanded="false"/);
  assert.match(html, /id="category-body-life" hidden/);
  assert.match(html, /3 статьи · по дням периода/);
  assert.ok(html.includes(fmt.money(6000)));
  assert.ok(html.includes(fmt.percent(25, 1)));
  assert.match(html, /сейчас вне сезона/);
  assert.doesNotMatch(html, /data-edit=/);
  ctx.state.expenses.expense_categories[0].title = '<img src=x onerror=alert(1)>';
  const escaped = renderCategories(ctx);
  assert.doesNotMatch(escaped, /<img/);
  assert.match(escaped, /&lt;img/);
});

test('раскрытие категории независимо; правки сумм и сезонов не меняют процент другой категории', () => {
  const ctx = categoryContext(); ctx.ui.open.add('cat:life');
  let html = renderCategories(ctx);
  assert.match(html, /data-toggle="cat:life" aria-expanded="true"/);
  assert.match(html, /data-toggle="cat:joy" aria-expanded="false"/);
  assert.match(html, /data-edit="expenses\|expense_categories\|monthly_amount"[^>]*value="6000"[^>]* disabled/);
  assert.match(html, /data-scroll-row="skis"/);
  assert.match(html, /data-edit="expenses\|expense_items\|season_from"/);
  applyEdit(ctx.store, el({ edit: 'expenses|expense_items|amount', key: '{"id":"food"}', type: 'money' }, '6000'), ctx.fmt);
  html = renderCategories(ctx);
  assert.ok(html.includes(fmt.money(8000)));
  assert.ok(html.includes(fmt.percent(25, 1)));
  handleCategories(click('drop-season', 'expenses|expense_items|skis'), ctx);
  html = renderCategories(ctx);
  assert.ok(html.includes(fmt.money(9000)), 'бывшая сезонная статья включилась в сумму');
  assert.ok(html.includes(fmt.percent(25, 1)), 'заданный процент другой категории сохранился');
  assert.match(html, /data-del="expenses\|expense_categories"/);
  assert.ok(ctx.ui.open.has('cat:life'), 'правка не сворачивает категорию');
  assert.ok(!ctx.ui.open.has('cat:joy'));
});

test('категории читателя: можно раскрывать, поля недоступны, действий редактирования нет', () => {
  const ctx = categoryContext(); ctx.canEdit = false;
  ctx.ui.open.add('cat:life'); ctx.ui.open.add('cat:joy');
  const html = renderCategories(ctx);
  assert.match(html, /data-toggle="cat:life"/);
  for (const [, tag] of html.matchAll(/(<(?:input|select)\b[^>]*>)/g)) assert.match(tag, / disabled/);
  assert.doesNotMatch(html, /data-add=|data-del=|data-add-season=|data-drop-season=/);
  assert.equal(handleCategories(click('drop-season', 'expenses|expense_items|skis'), ctx), false);
  assert.equal(ctx.state.expenses.expense_items[2].season_from, '12-01');
});

test('процентная категория без подкатегорий: ввод процента без суммы, валидация и немедленный пересчёт', () => {
  const ctx = categoryContext(); ctx.ui.open.add('cat:joy');
  ctx.state.income.periods = [{ id: 'p', year: 2027, pay_date: '2027-03-20', calc_mode: 'manual', income_net: 50000, taxable: false }];
  const html = renderCategories(ctx).split('id="category-body-joy"')[1].split('</section>')[0];
  assert.match(html, /data-edit="expenses\|expense_categories\|percent_value"[^>]*value="25"/);
  assert.doesNotMatch(html, /monthly_amount|data-edit="expenses\|expense_items\|amount"|data-amount-season-edit/);
  assert.match(html, /\+ подкатегория/);
  const input = value => el({ edit: 'expenses|expense_categories|percent_value', key: '{"id":"joy"}', type: 'number' }, value);
  applyEdit(ctx.store, input('12,5'), ctx.fmt);
  ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today });
  assert.equal(ctx.sim.byId.get('p').expenses.categories.find(c => c.category_id === 'joy').amount, 6250);
  for (const value of ['-1', '101']) assert.throws(() => applyEdit(ctx.store, input(value), ctx.fmt), /от 0 до 100/);
  assert.equal(ctx.state.expenses.expense_categories[1].percent_value, 12.5);
});

test('распределить выплату: проценты соблюдаются, остаток делится только между фиксированными', () => {
  const ctx = categoryContext();
  ctx.state.income.periods = [{ id: 'p', year: 2027, pay_date: '2027-03-20', calc_mode: 'manual', income_net: 10000, taxable: false }];
  const amounts = () => Object.fromEntries(ctx.state.expenses.expense_period_overrides.map(o => [o.category_id, o.amount]));
  const spread = () => { ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today }); handlePeriods(click('spread-categories', 'p'), ctx); };
  spread();
  assert.deepEqual(amounts(), { life: 7500, joy: 2500, winter: 0 });
  ctx.state.expenses.expense_items[0].amount = 8000;
  spread();
  assert.equal(amounts().joy, 2500);
  ctx.state.expenses.expense_categories = ctx.state.expenses.expense_categories.filter(c => c.id === 'joy');
  ctx.state.expenses.expense_period_overrides = [];
  spread();
  assert.deepEqual(amounts(), { joy: 2500 }, 'оставшиеся 7500 свободны, процент не доводится до 100');
  ctx.state.expenses.expense_categories = ['a', 'b', 'c', 'd'].map(id => ({ id, mode: 'fixed_month', monthly_amount: 1 }));
  ctx.state.expenses.expense_period_overrides = [];
  ctx.state.income.periods[0].income_net = 2;
  spread();
  assert.equal(Object.values(amounts()).reduce((s, n) => s + n, 0), 2, 'округление не создаёт лишние деньги');
});

test('расходы процентной категории не зависят от денежных сезонов; старые факты сохранены', () => {
  const ctx = categoryContext();
  ctx.state.expenses.expense_categories[1].amount_seasons = [{ from: '12-01', to: '12-31', amount: 100 }];
  ctx.state.expenses.expense_categories[1].monthly_amount = 0;
  ctx.state.facts = { expense_facts: [{ ym: '2027-03', category_id: 'joy', item_key: 'old', item_title: 'Старая статья', amount: 123 }] };
  const html = renderFacts(ctx);
  assert.match(html, /<b>Радости<\/b>/);
  assert.match(html, /Старая статья.*ранее внесено по статье/);
  assert.match(html, /data-edit="facts\|expense_facts\|amount"[^>]*value="123"/);
});

test('процентные подкатегории: общий процент недоступен для ввода и пересчитывается при правке и удалении', () => {
  const ctx = categoryContext(); ctx.ui.open.add('cat:joy');
  ctx.state.expenses.expense_items.push(
    { id: 'a', category_id: 'joy', title: 'Кафе', amount: 99999, percent_value: 5 },
    { id: 'b', category_id: 'joy', title: 'Кино', amount: 77777, percent_value: 7.5 },
  );
  const body = () => renderCategories(ctx).split('id="category-body-joy"')[1].split('</section>')[0];
  assert.match(body(), /data-edit="expenses\|expense_categories\|percent_value"[^>]*value="12.5"[^>]* disabled/);
  assert.match(body(), /data-edit="expenses\|expense_items\|percent_value"/);
  assert.doesNotMatch(body(), /data-edit="expenses\|expense_items\|amount"|monthly_amount|data-amount-season-edit/);
  const itemInput = value => el({ edit: 'expenses|expense_items|percent_value', key: '{"id":"a"}', type: 'number' }, value);
  applyEdit(ctx.store, itemInput('10'), ctx.fmt);
  assert.match(body(), /data-edit="expenses\|expense_categories\|percent_value"[^>]*value="17.5"[^>]* disabled/);
  for (const value of ['-1', '101']) assert.throws(() => applyEdit(ctx.store, itemInput(value), ctx.fmt), /от 0 до 100/);
  deleteRow(ctx.store, 'expenses', 'expense_items', { id: 'b' });
  assert.match(body(), /data-edit="expenses\|expense_categories\|percent_value"[^>]*value="10"[^>]* disabled/);
  deleteRow(ctx.store, 'expenses', 'expense_items', { id: 'a' });
  assert.match(body(), /data-edit="expenses\|expense_categories\|percent_value"[^>]*value="25"/);
  ctx.canEdit = false;
  assert.doesNotMatch(body(), /data-add=|data-del=/);
});

test('расходы и ручное распределение: денежный план подкатегорий соответствует их процентам', () => {
  const ctx = categoryContext();
  ctx.state.income.periods = [{ id: 'p', year: 2027, pay_date: '2027-03-20', calc_mode: 'manual', income_net: 10000, taxable: false }];
  ctx.state.expenses.expense_categories = [{ id: 'joy', title: 'Радости', mode: 'percent_income', percent_value: 0 }];
  ctx.state.expenses.expense_items = [
    { id: 'a', category_id: 'joy', title: 'Кафе', percent_value: 5 },
    { id: 'b', category_id: 'joy', title: 'Кино', percent_value: 7.5 },
    { id: 'off', category_id: 'joy', title: 'Зимний отдых', percent_value: 20, season_from: '12-01', season_to: '12-31' },
  ];
  ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today });
  handlePeriods(click('spread-categories', 'p'), ctx);
  assert.equal(ctx.state.expenses.expense_period_overrides[0].amount, 1250);
  const html = renderFacts(ctx);
  assert.match(html, /Кафе<\/td>\s*<td[^>]*>500/);
  assert.match(html, /Кино<\/td>\s*<td[^>]*>750/);
  assert.doesNotMatch(html, /Зимний отдых/);
  ctx.state.expenses.expense_period_overrides[0].amount = 2000;
  ctx.sim = simulate(ctx.state, ctx.cfg, { today: ctx.today });
  assert.match(renderFacts(ctx), /Кафе<\/td>\s*<td[^>]*>800/);
  ctx.state.facts = { expense_facts: [{ ym: '2027-03', category_id: 'joy', item_key: '', amount: 321 }] };
  assert.match(renderFacts(ctx), /Без подкатегории.*ранее внесено по категории/);
  assert.match(renderFacts(ctx), /data-edit="facts\|expense_facts\|amount"[^>]*value="321"/);
});

test('добавленная категория и статья открыты до перерисовки, фокус получает поле ввода', () => {
  const ctx = categoryContext(), listeners = {};
  attachEditing({ addEventListener(type, fn) { listeners[type] = fn; } }, ctx.store, () => ctx, e => { throw e; });
  for (const [table, row, target] of [
    ['expense_categories', { id: 'new', title: 'Новая категория', mode: 'fixed_month', monthly_amount: 0 }, { section: 'cat:new' }],
    ['expense_items', { id: 'new-item', category_id: 'new', title: 'Новая статья', amount: 0 }, { row: 'new-item' }],
  ]) {
    const original = ctx.store.update;
    ctx.store.update = (domain, fn) => {
      assert.ok(ctx.ui.open.has('cat:new'));
      assert.deepEqual(ctx.ui.scrollTarget, target);
      original.call(ctx.store, domain, fn);
    };
    listeners.click({ target: { closest: s => s === '[data-add]' ? { dataset: { add: `expenses|${table}`, row: JSON.stringify(row) } } : null } });
    ctx.store.update = original;
    assert.match(renderCategories(ctx), /data-toggle="cat:new" aria-expanded="true"/);
    if (table === 'expense_items') assert.match(renderCategories(ctx), /data-scroll-row="new-item"/);
    let inputFocused = false, headerFocused = false;
    const targetNode = {
      getAttribute: () => target.section ?? target.row,
      querySelector: selector => selector.startsWith('input') ? { focus: () => { inputFocused = true; } } : { focus: () => { headerFocused = true; } },
      scrollIntoView() {},
    };
    scrollToPending({ querySelectorAll: () => [targetNode], querySelector: () => null, style: { setProperty() {} } }, ctx.ui);
    assert.equal(inputFocused, true); assert.equal(headerFocused, false);
    assert.equal(ctx.ui.scrollTarget, null);
  }
});

test('сезонная сумма: редактирование черновика, запрет пересечений, сохранение, удаление и читатель',()=>{
  const ctx=categoryContext();ctx.ui.open.add('cat:life');
  const key=index=>JSON.stringify({table:'expense_items',id:'food',index});
  assert.equal(handleCategories(click('amount-season-edit',key(null)),ctx),true);
  const change=(name,value)=>changeCategories({target:{closest:s=>s==='[data-amount-season-field]'?{dataset:{amountSeasonField:name},value}:null}},ctx);
  change('from','12-01');change('to','02-28');change('amount','12000');
  assert.equal(handleCategories(click('amount-season-save',''),ctx),true);
  assert.deepEqual(ctx.state.expenses.expense_items[0].amount_seasons,[{from:'12-01',to:'02-28',amount:12000}]);
  handleCategories(click('amount-season-edit',key(null)),ctx);
  change('from','02-28');change('to','03-10');change('amount','5000');
  assert.throws(()=>handleCategories(click('amount-season-save',''),ctx),/пересекаться/);
  assert.equal(ctx.state.expenses.expense_items[0].amount_seasons.length,1);
  change('from','03-01');assert.equal(handleCategories(click('amount-season-save',''),ctx),true);
  assert.ok(renderCategories(ctx).includes(fmt.money(5000)), 'сезонная сумма статьи видна в разделе');
  handleCategories(click('amount-season-delete',key(0)),ctx);
  assert.equal(ctx.state.expenses.expense_items[0].amount_seasons.length,1);
  assert.equal(handleCategories(click('amount-season-edit',key(null)),{...ctx,canEdit:false}),false);
});

test('Расходы: сезонная сумма статьи соответствует выплатам месяца, подсказка о допуске убрана',()=>{
  const ctx=categoryContext();
  ctx.state.expenses.expense_items[0].amount_seasons=[{from:'03-01',to:'03-31',amount:8000}];
  ctx.state.income.periods=[{id:'p',year:2027,pay_date:'2027-03-05',window_start:'2027-03-01',window_end:'2027-03-31',calc_mode:'manual',taxable:false,income_net:50000}];
  ctx.sim=simulate(ctx.state,ctx.cfg);
  ctx.ui.draft.facts={month:'2027-03'};
  const html=renderFacts(ctx);
  assert.ok(html.includes(fmt.money(8000)));
  assert.doesNotMatch(html,/План — то, что заложено|Отклонение больше/);
});
