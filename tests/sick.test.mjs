import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sickFormula, sickParameters, computeSickLeaves, sickPeriods, sickPeriodId } from '../src/engine/sick.js';
import { computeIncome } from '../src/engine/income.js';
import { simulate, freezePeriods, forecastBeyondPlan } from '../src/engine/allocation.js';
import { createConfig } from '../src/core/config.js';
import { averageDailyEarnings } from '../src/engine/vacation.js';
import { renderSick, handleSick, earningsHelp } from '../src/ui/sick.js';
import { deleteRow } from '../src/ui/edit.js';
import { createFormat } from '../src/core/format.js';

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
      calc_mode: 'manual', manual_kind: 'bonus', income_net: 10000, taxable: true, locked: false, income_manual: true },
  ], payout_slots: [], vacations: [], sick_leaves: [{ ...s, employer_pay_date: '2026-11-15', sfr_pay_date: '2026-11-18' }],
    extra_incomes: [], income_history: [], salary_rates: [], tax_scales: [{ id: 'tax', valid_from_year: 2025, cumulative: true }],
    tax_brackets: [{ scale_id: 'tax', up_to: 2400000, rate: 13 }, { scale_id: 'tax', up_to: null, rate: 15 }],
  };
  state.savings = { goals: [{ id: 'g', kind_code: 'bucket', title: 'Цель', target_amount: 1e6, currency_code: 'RUB' }] };
  state.expenses = {}; state.debts = {}; state.gifts = {};
  return state;
}

test('план: два отдельных поступления с НДФЛ, распределением и без включения в базу отпускных', () => {
  const state = plan();
  const cfg = createConfig(state);
  const inc = computeIncome(state, cfg);
  assert.equal(inc.periods.length, 3);
  const employer = inc.byId.get(sickPeriodId('s', 'employer'));
  const sfr = inc.byId.get(sickPeriodId('s', 'sfr'));
  assert.equal(employer.salary, 5220);
  assert.equal(sfr.salary, 12180);
  assert.equal(employer.tax + sfr.tax, 2600);
  near(inc.monthGross(2026, 11), 10000 / 0.87);
  const sim = simulate(state, cfg);
  assert.ok(sim.byId.get(employer.period.id).allocations.g > 0);
  assert.equal(sim.rows.reduce((s, r) => s + r.totalIncome, 0), 27400);
});

test('налог: работодатель учитывает свою зарплату, СФР — свою отдельную базу, ручная сумма и возврат на авто', () => {
  const state = plan();
  state.income.periods[0].pay_date = '2026-11-12';
  state.income.periods[0].income_net = 2400000 * 0.87;
  let inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get(sickPeriodId('s', 'employer')).tax, 900);
  assert.equal(inc.byId.get(sickPeriodId('s', 'sfr')).tax, 1820);
  state.income.sick_leaves[0].sfr_prior_tax_base = 2400000;
  state.income.sick_leaves[0].employer_net = 5000;
  inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get(sickPeriodId('s', 'employer')).salary, 5000);
  assert.equal(inc.byId.get(sickPeriodId('s', 'sfr')).tax, 2100);
});

test('поступления: без дат или данных денег нет, пересоздание не дублирует, закрепление сохраняет историю', () => {
  const state = plan();
  state.income.sick_leaves[0].sfr_pay_date = null;
  let inc = computeIncome(state, createConfig(state));
  assert.equal(inc.periods.length, 2);
  state.income.periods = inc.preparedPeriods;
  const sim = simulate(state, createConfig(state));
  state.income.periods = freezePeriods(state, sim, [sickPeriodId('s', 'employer')]).periods;
  state.income.sick_leaves[0].earnings1 = 0;
  state.income.sick_leaves[0].employer_pay_date = '2026-12-01';
  inc = computeIncome(state, createConfig(state));
  assert.equal(inc.byId.get(sickPeriodId('s', 'employer')).salary, 5220);
  assert.equal(inc.byId.get(sickPeriodId('s', 'employer')).period.pay_date, '2026-11-15');
  assert.equal(inc.preparedPeriods.length, 2);
  state.income.sick_leaves[0].benefit_enabled = false;
  assert.equal(computeIncome(state, createConfig(state)).periods.length, 2, 'закреплённое поступление не исчезает');
});

test('расходы: больничное не добавляет долю фиксированных месячных расходов; процентные используют его доход', () => {
  const state = plan();
  state.expenses.expense_categories = [{ id: 'c', mode: 'fixed_month', monthly_amount: 9000 }];
  let sim = simulate(state, createConfig(state));
  assert.equal(sim.byId.get('salary').categoriesTotal, 9000);
  assert.equal(sim.byId.get(sickPeriodId('s', 'employer')).categoriesTotal, 0);
  assert.equal(sim.byId.get(sickPeriodId('s', 'sfr')).categoriesTotal, 0);
  state.expenses.expense_categories[0].mode = 'percent_income';
  sim = simulate(state, createConfig(state));
  assert.equal(sim.byId.get(sickPeriodId('s', 'employer')).categoriesTotal, 5220);
});

test('больничные и отпуска: пересекающиеся периоды исключаются из среднего один раз', () => {
  const result = averageDailyEarnings({ start: '2026-12-01', monthGross: () => 100000,
    sickLeaves: [{ start_date: '2026-11-01', end_date: '2026-11-10' }, { start_date: '2026-11-05', end_date: '2026-11-15' }],
    vacations: [{ start_date: '2026-11-07', end_date: '2026-11-20' }],
  });
  assert.equal(result.months.find(m => m.m === 11).excludedDays, 20);
});

test('интерфейс: памятка, причины, отдельные платежи, ручная рамка и сброс; читатель не редактирует', () => {
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

test('удаление больничного: атомарно убирает источник и выплаты, затем зависимые отчисления', () => {
  const state = plan();
  state.income.periods = sickPeriods(state.income, computeSickLeaves(state.income));
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
  assert.equal(inc.byId.get(sickPeriodId('s', 'sfr')).salary, 0);
  assert.equal(inc.byId.get(sickPeriodId('s', 'sfr')).sick.pendingTax, true);
  assert.ok(inc.warnings.some(w => w.code === 'sick_no_tax_scale'));
  state.income.sick_leaves[0].sfr_net = 12000;
  assert.equal(computeIncome(state, cfg).byId.get(sickPeriodId('s', 'sfr')).salary, 12000);
  state.income.sick_leaves.push({ ...state.income.sick_leaves[0], id: 'duplicate' });
  const forms = computeSickLeaves(state.income);
  assert.equal(forms.filter(f => !f.errors.length).length, 1);
  assert.match(forms.find(f => f.errors.length).errors.join(' '), /пересекаются/);
  state.settings.account_settings.base_currency = 'USD';
  inc = computeIncome(state, createConfig(state));
  assert.equal(inc.periods.filter(r => r.period.sick_leave_id).length, 0);
});

test('план: пособие не делит отпускные и не превращается в повторяющийся доход за пределами плана', () => {
  const state = plan();
  state.income.periods[0].window_end = '2026-11-30';
  state.income.vacations = [{ id: 'v', start_date: '2026-11-15', end_date: '2026-11-20', pay_manual: true, pay_amount: 6000 }];
  const inc = computeIncome(state, createConfig(state));
  assert.deepEqual(inc.vacations[0].split.map(p => p.period_id), ['salary']);
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
