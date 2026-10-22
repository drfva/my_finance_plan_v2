import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sickFormula, sickParameters, computeSickLeaves, sickPeriods, sickPeriodId, splitSickPay } from '../src/engine/sick.js';
import { computeIncome } from '../src/engine/income.js';
import { simulate, freezePeriods, forecastBeyondPlan } from '../src/engine/allocation.js';
import { createConfig } from '../src/core/config.js';
import { averageDailyEarnings } from '../src/engine/vacation.js';
import { renderSick, handleSick, earningsHelp } from '../src/ui/sick.js';
import { deleteRow } from '../src/ui/edit.js';
import { createFormat } from '../src/core/format.js';
import { render as renderVacations, title as vacationTitle } from '../src/ui/vacations.js';
import { title as sickTitle } from '../src/ui/sick.js';
import { render as renderDashboard } from '../src/ui/dashboard.js';
import { render as renderPeriods } from '../src/ui/periods.js';

const leaf = extra => ({ id: 's', start_date: '2026-11-01', end_date: '2026-11-10', benefit_enabled: true,
  reason: 'illness', insurance_years: 8, insurance_months: 0, earnings1: 730000, earnings2: 730000,
  district_coefficient: 1, employment_fraction: 1, ...extra });
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 0.011, `${label || ''}: ${a} ≠ ${b}`);

test('больничный: 60/80/100% стажа, календарные дни и первые три дня работодателя', () => {
  for (const [years, percent] of [[4, 0.6], [5, 0.8], [7, 0.8], [8, 1]]) {
    const f = sickFormula(leaf({ insurance_years: years }));
    assert.deepEqual(f.errors, []);
    assert.equal(f.daily, 2000);
    assert.equal(f.count, 10);
    assert.equal(f.paidDays, 10);
    assert.equal(f.employerGross, 3 * 2000 * percent);
    assert.equal(f.sfrGross, 7 * 2000 * percent);
  }
});

test('больничный: предельные базы применяются к каждому году и среднему дневному', () => {
  const f = sickFormula(leaf({ earnings1: 1e7, earnings2: 1e7 }));
  assert.equal(f.base, 2225000 + 2759000);
  assert.equal(f.daily, 6827.40);
  near(f.employerGross + f.sfrGross, 68274);
  const replaced = sickFormula(leaf({ base_year1: 2023, base_year2: 2024, replacement_confirmed: true,
    earnings1: 1e7, earnings2: 1e7, excluded_days: 365 }));
  assert.equal(replaced.daily, 6827.40, 'предел не меняется на годы замены');
});

test('больничный: МРОТ по календарным месяцам, районный коэффициент и неполная ставка', () => {
  const s = leaf({ start_date: '2026-02-27', end_date: '2026-03-02', earnings1: 0, earnings2: 0,
    insurance_years: 0, insurance_months: 3, district_coefficient: 1.5, employment_fraction: 0.5 });
  const f = sickFormula(s);
  assert.deepEqual(f.errors, []);
  near(f.days[0].amount, 27093 * 1.5 * 0.5 / 28);
  near(f.days[3].amount, 27093 * 1.5 * 0.5 / 31);
  const actual = sickFormula(leaf({ district_coefficient: 1.5, employment_fraction: 0.5 }));
  assert.equal(actual.daily, 2000, 'фактический заработок повторно не умножается на коэффициент/ставку');
  const fullMonth = sickFormula(leaf({ start_date: '2026-02-01', end_date: '2026-02-28', insurance_years: 0, insurance_months: 1, prior_case_days: 3 }));
  assert.equal(fullMonth.sfrGross, 27093, 'без лишних копеек из-за округления дней полного месяца');
});

test('больничный: неизвестный год, пропущенная база и незаконная замена не превращаются в нулевой заработок', () => {
  assert.ok(sickFormula(leaf({ earnings1: null })).errors.length);
  assert.ok(sickFormula(leaf({ start_date: '2027-01-01', end_date: '2027-01-02' })).errors.length);
  assert.equal(sickParameters(leaf({ start_date: '2027-01-01' })).mrot, undefined);
  assert.ok(sickFormula(leaf({ base_year1: 2023 })).errors.length);
  assert.ok(sickFormula(leaf({ excluded_days: 730 })).errors.length);
  assert.ok(sickFormula(leaf({ insurance_months: 12 })).errors.length);
  assert.ok(sickFormula(leaf({ employer_net: 999999 })).errors.length);
});

test('больничный: продолжение не создаёт ещё три дня работодателя, база относится к началу случая', () => {
  const f = sickFormula(leaf({ start_date: '2027-01-01', end_date: '2027-01-04', case_start_date: '2026-12-29', prior_case_days: 3 }));
  assert.deepEqual(f.errors, []);
  assert.equal(f.params.year, 2026);
  assert.equal(f.employerGross, 0);
  assert.equal(f.sfrGross, 8000);
});

test('уход: до восьми лет 100% независимо от стажа, с восьми дома с 11-го дня — 50% среднего', () => {
  const child = leaf({ reason: 'child', child_age: 7, recipient: 'Ребёнок', treatment: 'outpatient',
    start_date: '2026-11-01', end_date: '2026-11-15', insurance_years: 1 });
  const young = sickFormula(child);
  assert.deepEqual(young.errors, []);
  assert.equal(young.employerGross, 0);
  assert.equal(young.sfrGross, 30000);
  const older = sickFormula({ ...child, child_age: 8 });
  assert.equal(older.sfrGross, 10 * 1200 + 5 * 1000);
  const inpatient = sickFormula({ ...child, child_age: 8, treatment: 'inpatient' });
  assert.equal(inpatient.sfrGross, 15 * 1200);
});

test('уход: общий годовой лимит по получателю, ограничения случая и ранее оплаченные дни', () => {
  const first = leaf({ id: 'a', reason: 'child', child_age: 6, recipient: 'Маша', treatment: 'outpatient', used_days: 58 });
  const second = { ...first, id: 'b', start_date: '2026-11-20', end_date: '2026-11-25' };
  const forms = computeSickLeaves({ sick_leaves: [second, first] });
  assert.equal(forms[0].paidDays, 2);
  assert.equal(forms[1].paidDays, 0);
  const third = computeSickLeaves({ sick_leaves: [first, { ...second, recipient: 'Петя', used_days: 0 }] });
  assert.equal(third[1].paidDays, 6);
  const family = sickFormula(leaf({ reason: 'family', recipient: 'Родитель', treatment: 'outpatient' }));
  assert.equal(family.paidDays, 7);
  assert.equal(sickFormula(leaf({ reason: 'family', recipient: 'Родитель', treatment: 'inpatient' })).paidDays, 0);
});

test('уход: особые категории ребёнка и отпуск, собственная болезнь при отпуске требует уточнения дат', () => {
  const s = leaf({ reason: 'child', child_age: 9, recipient: 'Ребёнок', treatment: 'outpatient', child_category: 'disabled', used_days: 118 });
  assert.equal(sickFormula(s).paidDays, 2);
  assert.equal(sickFormula({ ...s, child_category: 'unlimited_any', used_days: 999 }).paidDays, 10);
  const vacations = [{ start_date: '2026-11-01', end_date: '2026-11-03' }];
  assert.equal(sickFormula({ ...s, used_days: 0 }, { vacations }).paidDays, 7);
  assert.match(sickFormula(leaf(), { vacations }).warnings.join(' '), /перенос/);
});

test('особый случай: подтверждённые начисления, ручной ноль и отсутствие данных', () => {
  const f = sickFormula(leaf({ reason: 'manual', employer_gross: 0, sfr_gross: 10000, sfr_net: 0 }));
  assert.deepEqual(f.errors, []);
  assert.equal(f.sfrGross, 10000);
  assert.ok(sickFormula(leaf({ reason: 'manual' })).errors.length);
  assert.equal(sickFormula({ id: 'old', start_date: '2026-11-01', end_date: '2026-11-10' }).disabled, true);
});

function plan(s = leaf()) {
  const state = JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json', import.meta.url), 'utf8'));
  state.income = { ...state.income, periods: [
    { id: 'salary', year: 2026, slot_order: 1, pay_date: '2026-11-20', window_start: '2026-11-01', window_end: '2026-11-15',
      calc_mode: 'auto', income_net: 10000, taxable: true, locked: false, income_manual: true },
  ], payout_slots: [], vacations: [], sick_leaves: [{ ...s, employer_pay_date: '2026-11-15', sfr_pay_date: '2026-11-18' }],
    extra_incomes: [], income_history: [], salary_rates: [], tax_scales: [{ id: 'tax', valid_from_year: 2025, cumulative: true }],
    tax_brackets: [{ scale_id: 'tax', up_to: 2400000, rate: 13 }, { scale_id: 'tax', up_to: null, rate: 15 }],
  };
  state.savings = { goals: [{ id: 'g', kind_code: 'bucket', title: 'Цель', target_amount: 1e6, currency_code: 'RUB' }] };
  state.expenses = {}; state.debts = {}; state.gifts = {};
  return state;
}

test('план: больничный входит в выплату за свой расчётный период, без отдельных поступлений и базы отпускных', () => {
  const state = plan();
  const cfg = createConfig(state);
  const inc = computeIncome(state, cfg);
  assert.equal(inc.periods.length, 1);
  const row = inc.byId.get('salary');
  const employer = row.sickParts.find(x => x.payer === 'employer');
  const sfr = row.sickParts.find(x => x.payer === 'sfr');
  assert.equal(employer.net, 5220);
  assert.equal(sfr.net, 12180);
  assert.equal(employer.tax + sfr.tax, 2600);
  near(inc.monthGross(2026, 11), 10000 / 0.87);
  const sim = simulate(state, cfg);
  assert.ok(sim.byId.get('salary').allocations.g > 0);
  assert.equal(sim.rows.reduce((s, r) => s + r.totalIncome, 0), 27400);
});

test('налог: работодатель учитывает свою зарплату, СФР — свою отдельную базу, ручная сумма и возврат на авто', () => {
  const state = plan();
  state.income.periods[0].pay_date = '2026-11-12';
  state.income.periods[0].income_net = 2400000 * 0.87;
  let inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get('salary').sickParts.find(x => x.payer === 'employer').tax, 900);
  assert.equal(inc.byId.get('salary').sickParts.find(x => x.payer === 'sfr').tax, 1820);
  state.income.sick_leaves[0].sfr_prior_tax_base = 2400000;
  state.income.sick_leaves[0].employer_net = 5000;
  inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get('salary').sickParts.find(x => x.payer === 'employer').net, 5000);
  assert.equal(inc.byId.get('salary').sickParts.find(x => x.payer === 'sfr').tax, 2100);
});

test('больничный: фактическая дата не меняет деление по периодам; фиксация сохраняет начисление и историю', () => {
  const state = plan();
  state.income.sick_leaves[0].sfr_pay_date = null;
  let inc = computeIncome(state, createConfig(state));
  assert.equal(inc.periods.length, 1);
  assert.equal(inc.byId.get('salary').sickPay, 17400);
  state.income.periods = inc.preparedPeriods;
  const sim = simulate(state, createConfig(state));
  state.income.periods = freezePeriods(state, sim, ['salary']).periods;
  state.income.sick_leaves[0].earnings1 = 0;
  state.income.sick_leaves[0].employer_pay_date = '2026-12-01';
  inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get('salary').salary, 10000);
  assert.equal(inc.byId.get('salary').sickPay, 17400);
  assert.equal(inc.byId.get('salary').sickGross, 20000);
  assert.equal(inc.preparedPeriods.length, 1);
  state.income.sick_leaves[0].benefit_enabled = false;
  assert.equal(computeIncome(state, createConfig(state)).byId.get('salary').sickPay, 17400, 'закреплённый больничный не исчезает');
  state.income.sick_leaves = [];
  assert.equal(computeIncome(state, createConfig(state)).byId.get('salary').sickPay, 17400, 'удаление листа сохраняет снимок');
});

test('расходы: больничное не добавляет долю фиксированных месячных расходов; процентные используют его доход', () => {
  const state = plan();
  state.expenses.expense_categories = [{ id: 'c', mode: 'fixed_month', monthly_amount: 9000 }];
  let sim = simulate(state, createConfig(state));
  assert.equal(sim.byId.get('salary').categoriesTotal, 9000);
  assert.equal(sim.rows.length, 1);
  state.expenses.expense_categories[0].mode = 'percent_income';
  sim = simulate(state, createConfig(state));
  assert.equal(sim.byId.get('salary').categoriesTotal, 27400);
});

test('больничные и отпуска: пересекающиеся периоды исключаются из среднего один раз', () => {
  const result = averageDailyEarnings({ start: '2026-12-01', monthGross: () => 100000,
    sickLeaves: [{ start_date: '2026-11-01', end_date: '2026-11-10' }, { start_date: '2026-11-05', end_date: '2026-11-15' }],
    vacations: [{ start_date: '2026-11-07', end_date: '2026-11-20' }],
  });
  assert.equal(result.months.find(m => m.m === 11).excludedDays, 20);
});

test('интерфейс: памятка, причины, деление по выплатам, ручная рамка и сброс; читатель не редактирует', () => {
  const state = plan(); state.income.sick_leaves[0].sfr_net = 10000;
  const fmt = createFormat({ locale: 'ru-RU', currency: 'RUB' });
  const ctx = { state, income: computeIncome(state, createConfig(state)), fmt, canEdit: true, today: '2026-10-22',
    ui: { open: new Set(['sick:s']) }, store: { update(domain, fn) { fn(state[domain]); } } };
  const html = renderSick(ctx);
  assert.match(earningsHelp(), /отпускные/);
  assert.match(html, /income\|sick_leaves\|earnings1/);
  assert.match(html, /class="own num"[^>]*sfr_net/);
  assert.match(html, /НДФЛ/);
  const ev = { target: { closest: selector => selector === '[data-sick-reset-net]' ? { dataset: { sickResetNet: 's|sfr' } } : null } };
  assert.equal(handleSick(ev, { ...ctx, canEdit: false }), false);
  assert.equal(handleSick(ev, ctx), true);
  assert.equal(state.income.sick_leaves[0].sfr_net, null);
  const viewer = renderSick({ ...ctx, canEdit: false });
  assert.doesNotMatch(viewer, /data-sick-reset-net|data-del=/);
});

function twoPeriods(s = leaf({ start_date: '2026-11-12', end_date: '2026-11-20' })) {
  const st = plan(s);
  const first = st.income.periods[0];
  st.income.periods.push({ ...first, id: 'salary2', slot_order: 2, pay_date: '2026-12-05', window_start: '2026-11-16', window_end: '2026-11-30' });
  st.income.periods.forEach(p => { p.income_manual = false; });
  st.income.salary_rates = [{ id: 'rate', effective_from: '2026-01-01', amount: 60000, is_gross: false }];
  return st;
}

test('два расчётных периода: оклад уменьшается, больничный добавляется за свои дни, даты поступлений не требуются', () => {
  const st = twoPeriods();
  st.income.sick_leaves[0].employer_pay_date = null;
  st.income.sick_leaves[0].sfr_pay_date = null;
  const without = computeIncome({ ...st, income: { ...st.income, sick_leaves: [] } }, createConfig(st));
  const inc = computeIncome(st, createConfig(st));
  assert.equal(inc.periods.length, 2);
  assert.equal(inc.byId.get('salary').sickGross, 8000);
  assert.equal(inc.byId.get('salary2').sickGross, 10000);
  assert.equal(inc.byId.get('salary').sickPay, 6960);
  assert.equal(inc.byId.get('salary2').sickPay, 8700);
  assert.ok(inc.periods.every(r => r.salary < without.byId.get(r.period.id).salary));
  assert.ok(inc.periods.every(r => r.total === r.salary + r.sickPay));
  st.income.sick_leaves[0].end_date = '2026-11-18';
  const edited = computeIncome(st, createConfig(st));
  assert.equal(edited.byId.get('salary').sickPay, 6960);
  assert.equal(edited.byId.get('salary2').sickPay, 5220);
  assert.ok(edited.byId.get('salary2').salary > inc.byId.get('salary2').salary);
});

test('больничный: ручная сумма делится с сохранением копеек, недостающий период не получает вымышленную выплату', () => {
  const st = twoPeriods();
  st.income.sick_leaves[0].sfr_net = 10000;
  st.income.sick_leaves[0].employer_net = 5000;
  let inc = computeIncome(st, createConfig(st));
  assert.equal(inc.periods.reduce((n, r) => n + r.sickPay, 0), 15000);
  assert.equal(inc.byId.get('salary').sickParts.find(x => x.payer === 'sfr').net, 1666.67);
  assert.equal(inc.byId.get('salary2').sickParts[0].net, 8333.33);
  st.income.periods.pop();
  inc = computeIncome(st, createConfig(st));
  assert.equal(inc.periods.length, 1);
  assert.equal(inc.byId.get('salary').sickGross, 8000);
  assert.equal(inc.warnings.find(w => w.code === 'sick_outside_plan').unassigned, 10000);
});

test('старые отдельные выплаты: будущие убираются, закреплённая не дублируется в окладе', () => {
  const st = twoPeriods();
  const old = { id: sickPeriodId('s', 'employer'), sick_leave_id: 's', sick_payer: 'employer', sick_gross: 6000,
    year: 2026, pay_date: '2026-11-15', window_start: '2026-11-15', window_end: '2026-11-15',
    calc_mode: 'manual', income_net: 5220, income_manual: false, locked: true };
  st.income.periods.push(old, { ...old, id: sickPeriodId('s', 'sfr'), sick_payer: 'sfr', sick_gross: 12000, locked: false });
  const inc = computeIncome(st, createConfig(st));
  assert.equal(inc.periods.length, 3);
  assert.equal(inc.byId.has(sickPeriodId('s', 'sfr')), false);
  assert.equal(inc.byId.get(old.id).salary, 5220);
  assert.ok(inc.periods.flatMap(r => r.sickParts ?? []).every(x => x.payer !== 'employer'));
  assert.equal(inc.periods.reduce((n, r) => n + (r.sickPay ?? 0), 0), 10440);
});

test('зафиксированный оклад без снимка больничного сохраняет историю до явной разблокировки', () => {
  const st = plan();
  st.income.periods[0].locked = true;
  let inc = computeIncome(st, createConfig(st));
  assert.equal(inc.byId.get('salary').sickPay, 0);
  assert.equal(inc.byId.get('salary').total, 10000);
  assert.ok(inc.warnings.some(w => w.code === 'sick_locked_period'));
  st.income.periods[0].locked = false;
  inc = computeIncome(st, createConfig(st));
  assert.equal(inc.byId.get('salary').sickPay, 17400);
});

test('распределение больничного: ручной особый случай и пересечение окон не удваивают сумму', () => {
  const st = twoPeriods(leaf({ reason: 'manual', start_date: '2026-11-12', end_date: '2026-11-20', employer_gross: 600, sfr_gross: 601 }));
  st.income.periods.push({ ...st.income.periods[0], id: 'bonus', calc_mode: 'manual', manual_kind: 'bonus' });
  const f = computeSickLeaves(st.income)[0];
  const split = splitSickPay(f, [...st.income.periods, { ...st.income.periods[0], id: 'overlap' }]);
  near(split.reduce((n, p) => n + p.gross, 0), 1201);
  assert.ok(split.every(p => p.period_id !== 'bonus'));
});

test('меню и Доходы: отдельные Отпуска/Больничные и больничный в колонке Обзора', () => {
  const st = twoPeriods();
  const cfg = createConfig(st), income = computeIncome(st, cfg), sim = simulate(st, cfg, { income });
  const ctx = { state: st, cfg, income, sim, fmt: cfg.formatter(), year: 2026, today: '2026-10-22', canEdit: true,
    ui: { open: new Set(['sick:s', 'period:salary']), draft: { dashboard: { view: 'income' } } } };
  assert.equal(vacationTitle(), 'Отпуска');
  assert.equal(sickTitle(), 'Больничные');
  assert.doesNotMatch(renderVacations(ctx), /income\|sick_leaves/);
  assert.match(renderSick(ctx), /Больничный по выплатам оклада/);
  assert.match(renderDashboard(ctx), /<th class="num">Больничный<\/th>/);
  const html = renderPeriods(ctx);
  assert.match(html, /больничный/);
  assert.doesNotMatch(html, /пособие по больничному|Отпуска и больничные/);
});

test('удаление больничного: атомарно убирает источник и выплаты, затем зависимые отчисления', () => {
  const state = plan();
  state.income.periods.push({ id: sickPeriodId('s', 'sfr'), sick_leave_id: 's', sick_payer: 'sfr', sick_gross: 14000,
    year: 2026, pay_date: '2026-11-18', window_start: '2026-11-18', window_end: '2026-11-18', income_net: 12180, locked: true });
  state.savings.savings_period_overrides = [{ goal_id: 'g', period_id: sickPeriodId('s', 'sfr'), amount: 100 }];
  const store = { state, update(domain, fn) { fn(state[domain]);
    if (domain === 'income') assert.equal(state.income.periods.some(p => p.sick_leave_id), false);
  } };
  deleteRow(store, 'income', 'sick_leaves', { id: 's' });
  assert.equal(state.income.sick_leaves.length, 0);
  assert.equal(state.income.periods.length, 1);
  assert.equal(state.savings.savings_period_overrides.length, 0);
});

test('план: неизвестный налог, другая валюта и пересечения не создают лишнего дохода', () => {
  const state = plan();
  state.income.tax_scales = []; state.income.tax_brackets = [];
  const cfg = createConfig(state);
  let inc = computeIncome(state, cfg);
  assert.equal(inc.byId.get('salary').sickPay, 0);
  assert.equal(inc.byId.get('salary').sickPendingTax, true);
  assert.ok(inc.warnings.some(w => w.code === 'sick_no_tax_scale'));
  state.income.sick_leaves[0].sfr_net = 12000;
  assert.equal(computeIncome(state, cfg).byId.get('salary').sickPay, 12000);
  state.income.sick_leaves.push({ ...state.income.sick_leaves[0], id: 'duplicate' });
  const forms = computeSickLeaves(state.income);
  assert.equal(forms.filter(f => !f.errors.length).length, 1);
  assert.match(forms.find(f => f.errors.length).errors.join(' '), /пересекаются/);
  state.settings.account_settings.base_currency = 'USD';
  inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get('salary').sickPay, 0);
});

test('план: пособие не делит отпускные и не превращается в повторяющийся доход за пределами плана', () => {
  const state = plan();
  state.income.periods[0].window_end = '2026-11-30';
  state.income.vacations = [{ id: 'v', start_date: '2026-11-15', end_date: '2026-11-20', pay_manual: true, pay_amount: 6000 }];
  const inc = computeIncome(state, createConfig(state));
  assert.deepEqual(inc.vacations[0].split.map(p => p.period_id), ['salary']);
  state.income.vacations = [];
  const withSalary = simulate(state, createConfig(state));
  near(forecastBeyondPlan(withSalary, state.savings.goals[0]).perPayout, 10000, 'разовая часть больничного не продлевает регулярный темп');
  state.income.periods = [];
  state.income.vacations = [];
  const sim = simulate(state, createConfig(state));
  assert.equal(forecastBeyondPlan(sim, state.savings.goals[0]), null, 'разовое пособие не повторяется в прогнозе');
});

test('удаление года: даты пособия очищаются и выплаты не возникают заново', () => {
  const state = plan();
  state.income.plan_years = [{ year: 2026 }];
  state.income.periods = sickPeriods(state.income, computeSickLeaves(state.income));
  deleteRow({ state, update(domain, fn) { fn(state[domain]); } }, 'income', 'plan_years', { year: 2026 });
  assert.equal(state.income.sick_leaves[0].employer_pay_date, null);
  assert.equal(state.income.sick_leaves[0].sfr_pay_date, null);
  assert.equal(computeIncome(state, createConfig(state)).periods.length, 0);
});

test('разовые доходы остаются в своей выплате, повторное удаление больничного не трогает зарплату', () => {
  const state = plan();
  state.income.periods[0].pay_date = '2026-11-12';
  state.income.extra_incomes = [{ id: 'gift', date: '2026-11-19', amount: 1000, currency_code: 'RUB', counted_in_total: true }];
  const inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get('salary').extraIncome, 1000);
  assert.equal(inc.periods.reduce((s, r) => s + r.extraIncome, 0), 1000);
  const original = structuredClone(state.income.periods);
  deleteRow({ state, update(domain, fn) { fn(state[domain]); } }, 'income', 'sick_leaves', { id: 'not-found' });
  assert.deepEqual(state.income.periods, original);
});
