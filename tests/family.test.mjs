import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFamilyAllocator, familyBudget, validateFamilyRule, familyToday } from '../src/engine/family.js';
import { simulate } from '../src/engine/allocation.js';
import { createConfig } from '../src/core/config.js';

function fixture(rule, payments = [['2026-10-05', 100000]]) {
  const periods = payments.map(([date, total], i) => ({ period: { id: `p${i}`, pay_date: date }, total }));
  const income = { periods, byId: new Map(periods.map(r => [r.period.id, r])) };
  const state = { account: { id: 'personal' }, family_private: { membership: { id: 'm', family_id: 'f', source_account_id: 'personal', active: true },
    rules: [{ effective_from: '2026-10-01', ...rule }], contributions: [] } };
  return { state, income };
}

test('семейный взнос: фиксированный процент от всего дохода; нехватка переносится и гасится первой', () => {
  const ctx = fixture({ mode: 'percent', percent: 20 }, [['2026-10-05', 100000], ['2026-11-05', 100000]]);
  const a = createFamilyAllocator(ctx);
  const first = a.step(ctx.income.periods[0].period, 12000);
  assert.equal(first.amount, 12000);
  assert.equal(first.outstanding, 8000);
  const next = a.step(ctx.income.periods[1].period, 50000);
  assert.equal(next.amount, 28000);
  assert.equal(next.arrears_amount, 8000);
  assert.equal(next.current_amount, 20000);
  assert.equal(next.outstanding, 0);
  assert.equal(next.settlements[0].month, '2026-10');
  assert.equal(ctx.state.family_private.contributions.length, 0, 'прогноз не проводит операций');
});

test('семейный взнос: свободный остаток с лимитом суммы и процента', () => {
  for (const [rule, amount] of [[{}, 50000], [{ limit_amount: 40000 }, 40000], [{ limit_percent: 30 }, 15000], [{ limit_amount: 40000, limit_percent: 30 }, 15000]]) {
    const ctx = fixture({ mode: 'remainder', limit_scope: 'payment', ...rule });
    const row = createFamilyAllocator(ctx).step(ctx.income.periods[0].period, 50000);
    assert.equal(row.amount, amount);
    assert.equal(row.outstanding, 0);
  }
});

test('семейный взнос: месячная сумма делится пропорционально доходу и учитывает нехватку', () => {
  const ctx = fixture({ mode: 'monthly', amount: 20000 }, [['2026-10-05', 60000], ['2026-10-20', 40000]]);
  let a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 60000).amount, 12000);
  assert.equal(a.step(ctx.income.periods[1].period, 40000).amount, 8000);
  a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 5000).amount, 5000);
  assert.equal(a.step(ctx.income.periods[1].period, 40000).amount, 15000);
});

test('семейный взнос: добор и старый недобор не обходят потолок выплаты', () => {
  const ctx = fixture({ mode: 'monthly', amount: 40000, cap_per_payment: 15000 },
    [['2026-10-05', 50000], ['2026-10-20', 50000], ['2026-11-05', 50000]]);
  const a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 50000).amount, 15000);
  const last = a.step(ctx.income.periods[1].period, 50000);
  assert.equal(last.amount, 15000);
  assert.equal(last.outstanding, 10000);
  const next = a.step(ctx.income.periods[2].period, 50000);
  assert.equal(next.amount, 15000);
  assert.equal(next.arrears_amount, 10000);
  assert.equal(next.current_amount, 5000);
});

test('семейный взнос: пропущенный месяц с обязательством и месяц без доходов', () => {
  const ctx = fixture({ mode: 'monthly', amount: 10000 }, [['2026-10-05', 0], ['2026-12-05', 50000]]);
  const a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 0).outstanding, 10000);
  const next = a.step(ctx.income.periods[1].period, 50000);
  assert.equal(next.amount, 30000);
  assert.equal(next.arrears_amount, 20000);
  assert.equal(next.outstanding, 0);
});

test('семейный взнос: свободный месячный лимит не переносится как долг', () => {
  const ctx = fixture({ mode: 'remainder', limit_scope: 'month', limit_amount: 40000 },
    [['2026-10-05', 25000], ['2026-11-05', 100000]]);
  const a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 25000).amount, 25000);
  const next = a.step(ctx.income.periods[1].period, 100000);
  assert.equal(next.amount, 40000);
  assert.equal(next.outstanding, 0);
});

test('семейный взнос: месячный процентный лимит от остатков, превышение не отменяет проведённое', () => {
  const ctx = fixture({ mode:'remainder',limit_scope:'month',limit_percent:30 },[['2026-10-05',100000],['2026-10-20',100000]]);
  ctx.reference={byId:new Map(ctx.income.periods.map(r=>[r.period.id,{familyContribution:{available_before:50000}}]))};
  let a=createFamilyAllocator(ctx);
  const first=a.step(ctx.income.periods[0].period,50000);
  assert.equal(first.amount,30000);
  assert.equal(a.step(ctx.income.periods[1].period,50000).amount,0);
  ctx.state.family_private.contributions.push(first);
  a=createFamilyAllocator(ctx);
  a.step(ctx.income.periods[0].period,1);
  const last=a.step(ctx.income.periods[1].period,0);
  assert.equal(last.amount,0);
  assert.equal(last.limit_exceeded,15000);
});

test('семейный взнос: копейки сохраняются при переносе, части перевода точно дают его сумму', () => {
  const ctx=fixture({mode:'per_payment',amount:10.01},[['2026-10-05',100],['2026-11-05',100]]);
  const a=createFamilyAllocator({...ctx,round:n=>Math.round(n*100)/100});
  assert.equal(a.step(ctx.income.periods[0].period,3.33).outstanding,6.68);
  const next=a.step(ctx.income.periods[1].period,100);
  assert.equal(next.amount,16.69);
  assert.equal(next.arrears_amount,6.68);
  assert.equal(next.current_amount,10.01);
  assert.equal(next.outstanding,0);
});

test('семейный взнос: проведённая сумма и её состояние не меняются; после выхода новых взносов нет', () => {
  const ctx = fixture({ mode: 'per_payment', amount: 20000 }, [['2026-10-05', 100000], ['2026-11-05', 100000]]);
  const posted = createFamilyAllocator(ctx).step(ctx.income.periods[0].period, 12000);
  ctx.state.family_private.contributions.push(posted);
  ctx.state.family_private.rules.push({ effective_from: '2026-11-01', mode: 'percent', percent: 10 });
  let a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 1).amount, 12000);
  assert.equal(a.step(ctx.income.periods[1].period, 50000).amount, 18000);
  ctx.state.family_private.membership.active = false;
  a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 100000).amount, 12000);
  assert.equal(a.step(ctx.income.periods[1].period, 50000).amount, 0);
});

test('семейный взнос: новое месячное значение засчитывает уже переданное без возврата денег', () => {
  const ctx = fixture({ mode: 'monthly', amount: 40000 }, [['2026-10-05', 100000], ['2026-10-20', 100000]]);
  const first = createFamilyAllocator(ctx).step(ctx.income.periods[0].period, 100000);
  ctx.state.family_private.contributions.push(first);
  ctx.state.family_private.rules.push({ effective_from: '2026-10-10', mode: 'monthly', amount: 15000 });
  const a = createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period, 0).amount, 20000);
  const next = a.step(ctx.income.periods[1].period, 100000);
  assert.equal(next.amount, 0);
  assert.equal(next.outstanding, 0);
});

test('семейный взнос: смена режима отменяет месячный остаток, даже если следующая выплата в другом месяце',()=>{
  const ctx=fixture({mode:'monthly',amount:40000},[['2026-10-05',100000],['2026-11-05',100000]]);
  ctx.state.family_private.rules.push({effective_from:'2026-10-10',mode:'percent',percent:20});
  const a=createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period,10000).outstanding,30000);
  const next=a.step(ctx.income.periods[1].period,100000);
  assert.equal(next.amount,20000);
  assert.equal(next.arrears_amount,0);
  assert.equal(next.outstanding,0);
});

test('семейный взнос: ручная будущая сумма уменьшает остаток месяца и не обходит потолок',()=>{
  const ctx=fixture({mode:'monthly',amount:40000},[['2026-10-05',100000],['2026-10-20',100000]]);
  ctx.state.family_private.overrides=[{period_id:'p0',amount:30000}];
  let a=createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period,100000).amount,30000);
  assert.equal(a.step(ctx.income.periods[1].period,100000).amount,10000);
  ctx.state.family_private.rules[0].cap_per_payment=15000;
  a=createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period,100000).amount,15000);
  assert.equal(a.step(ctx.income.periods[1].period,100000).outstanding,10000);
});

test('семейный взнос: добровольное превышение и переход к месячному плану засчитывают уже переданные деньги',()=>{
  const ctx=fixture({mode:'percent',percent:20},[['2026-10-05',100000],['2026-10-20',100000]]);
  ctx.state.family_private.overrides=[{period_id:'p0',amount:30000}];
  ctx.state.family_private.rules.push({effective_from:'2026-10-10',mode:'monthly',amount:40000});
  const a=createFamilyAllocator(ctx);
  assert.equal(a.step(ctx.income.periods[0].period,100000).amount,30000);
  assert.equal(a.step(ctx.income.periods[1].period,100000).amount,10000);
});

test('семейная дата: смена месяца определяется Москвой, а не часовым поясом браузера',()=>{
  assert.equal(familyToday(new Date('2026-10-31T22:00:00Z')),'2026-11-01');
});

test('семейный бюджет: месяцы независимы, факт влияет только на статистику', () => {
  const family = { contributions: [
    { pay_date: '2026-10-05', status: 'posted', amount: 100000 },
    { pay_date: '2026-11-05', status: 'forecast', amount: 100000 },
  ], monthly_expenses: [{ month: '2026-10', amount: 80000 }, { month: '2026-11', amount: 90000 }],
  expense_facts: [{ month: '2026-10', amount: 75000 }] };
  assert.equal(familyBudget(family, '2026-10').balance, 20000);
  assert.equal(familyBudget(family, '2026-10').deviation, -5000);
  assert.equal(familyBudget(family, '2026-11').forecastBalance, 10000);
  family.expense_facts[0].amount = 150000;
  assert.equal(familyBudget(family, '2026-10').balance, 20000);
  assert.equal(familyBudget(family, '2026-11').forecastBalance, 10000);
});

test('семейный этап: раньше расходов и темпа подушки; никаких изменений без подключения', () => {
  const state = JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json', import.meta.url), 'utf8'));
  state.income = { periods: [{ id: 'p', year: 2026, pay_date: '2026-10-05', calc_mode: 'manual', taxable: false, income_net: 10000 }] };
  state.expenses = { expense_categories: [{ id: 'food', monthly_amount: 4000, mode: 'fixed_month', split_mode: 'even' }] };
  state.savings = { goals: [{ id: 'r', kind_code: 'reserve', currency_code: 'RUB', target_amount: 100000, pace_amount: 1000 }] };
  state.debts = {}; state.gifts = {};
  const before = simulate(state, createConfig(state));
  assert.equal(before.stages.some(s => s.code === 'family'), false);
  state.family_private = fixture({ mode: 'remainder' }).state.family_private;
  state.family_private.membership.source_account_id = state.account.id;
  state.settings.allocation_rules = [{ stage_code: 'family', priority: 0, enabled: true, params: {} }];
  const after = simulate(state, createConfig(state));
  assert.equal(after.rows[0].familyContribution.amount, 10000);
  assert.equal(after.rows[0].allocations.r ?? 0, 0);
  assert.equal(after.rows[0].unallocated, -4000);
  assert.equal(state.family_private.contributions.length, 0);
});

test('семейное правило: неверные суммы, проценты и даты отклоняются', () => {
  assert.throws(() => validateFamilyRule({ mode: 'percent', effective_from: '2026-10-01', percent: 101 }));
  assert.throws(() => validateFamilyRule({ mode: 'monthly', effective_from: '2026-02-30', amount: 1000 }));
  assert.throws(() => validateFamilyRule({ mode: 'monthly', effective_from: '2026-10-01', amount: -1 }));
  assert.equal(validateFamilyRule({ mode: 'remainder', effective_from: '2026-10-01', limit_scope: 'month', limit_percent: 30 }), true);
});
