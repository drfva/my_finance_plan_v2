import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createConfig } from '../src/core/config.js';
import { simulate, freezePeriods } from '../src/engine/allocation.js';

function plan(enabled=true) {
  const state=JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
  state.settings={account_settings:{},allocation_rules:[{stage_code:'installments',enabled:true,priority:3,params:{early_repayment:enabled}}]};
  state.income={periods:[['p1','2027-03-05',1500],['p2','2027-04-05',1000],['p3','2027-05-05',1000]].map(([id,date,amount])=>({id,year:2027,pay_date:date,window_start:date,window_end:date,calc_mode:'manual',taxable:false,income_net:amount,installment_snapshot:null}))};
  state.expenses={};state.gifts={};state.savings={goals:[]};
  state.debts={installments:[{id:'i',title:'Покупка',total:2000}],installment_payments:[{id:'i-1',installment_id:'i',pay_date:'2027-03-20',amount:1000},{id:'i-2',installment_id:'i',pay_date:'2027-04-20',amount:1000}]};
  return state;
}
const run=state=>simulate(state,createConfig(state));
const conservation=sim=>{for(const r of sim.rows)assert.equal(r.totalIncome,r.categoriesTotal+r.installmentsTotal+Object.values(r.debtPayments).reduce((a,b)=>a+b,0)+Object.values(r.allocations).reduce((a,b)=>a+b,0)+(r.familyContribution?.amount??0)+r.unallocated);};

test('рассрочки: выключено по умолчанию, досрочные суммы уменьшают следующие платежи',()=>{
  const off=plan(false);off.settings.allocation_rules[0].params={};
  assert.deepEqual(run(off).rows.map(r=>r.installmentsTotal),[1000,1000,0]);
  const sim=run(plan());
  assert.deepEqual(sim.rows.map(r=>r.installmentsTotal),[1500,500,0]);
  assert.equal(sim.rows[0].installmentDetails.find(d=>d.early).payment_id,'i-2');
  conservation(sim);
});

test('рассрочки: фиксация, перезагрузка и выключение правила сохраняют проведённое погашение',()=>{
  const state=plan(),sim=run(state),patch=freezePeriods(state,sim,['p1']);
  state.income.periods=patch.periods;state.settings.allocation_rules[0].params.early_repayment=false;
  assert.ok(state.income.periods[0].installment_snapshot.some(d=>d.early&&d.amount===500));
  const restored=run(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.rows.map(r=>r.installmentsTotal),[1500,500,0]);
  conservation(restored);
  state.settings.allocation_rules[0].enabled=false;
  assert.equal(run(state).rows[0].unallocated,0,'история сохраняется даже при выключении этапа');
});

test('рассрочки: будущая зафиксированная выплата защищена от досрочного уменьшения',()=>{
  const state=plan();state.income.periods[1].locked=true;
  state.income.periods[1].installment_snapshot=[{payment_id:'i-2',installment_id:'i',date:'2027-04-20',amount:1000,early:false}];
  assert.deepEqual(run(state).rows.map(r=>r.installmentsTotal),[1000,1000,0]);
});

test('рассрочки: проведённый зачёт сохраняется при пересоздании id графика',()=>{
  const state=plan();state.income.periods=freezePeriods(state,run(state),['p1']).periods;
  state.settings.allocation_rules[0].params.early_repayment=false;
  state.debts.installment_payments[1].id='new-second';
  assert.deepEqual(run(state).rows.map(r=>r.installmentsTotal),[1500,500,0]);
});

test('кредитки и рассрочки: свободный остаток расходуется по очереди их этапов',()=>{
  const state=plan();state.income.periods[0].income_net=2000;
  state.debts.credit_cards=[{id:'c',title:'Карта',currency_code:'RUB',grace_days:100}];
  state.debts.credit_card_ops=[{id:'op',card_id:'c',op_date:'2027-03-05',amount:1500,kind:'spend'}];
  state.settings.allocation_rules.push({stage_code:'credits',enabled:true,priority:4,params:{early_repayment:true}});
  const first=run(state);assert.ok(first.rows[0].byStage.early_installments>0);conservation(first);
  state.settings.allocation_rules[1].priority=2;
  const changed=run(state);assert.equal(changed.rows[0].byStage.early_installments,0);conservation(changed);
  assert.ok(changed.rows[0].debtPayments.c>first.rows[0].debtPayments.c);
});

test('рассрочки: досрочное погашение не забирает распределённые суммы целей и не превышает долг',()=>{
  const state=plan();state.income.periods[0].income_net=2500;
  state.savings.goals=[{id:'g',title:'Цель',kind_code:'bucket',currency_code:'RUB',priority:1,target_amount:1000,deadline:'2027-06-01'}];
  const sim=run(state);
  assert.equal(sim.rows[0].allocations.g,1000);
  assert.equal(sim.rows[0].byStage.early_installments,500);
  assert.equal(sim.rows.reduce((s,r)=>s+r.installmentsTotal,0),2000);
  conservation(sim);
});
