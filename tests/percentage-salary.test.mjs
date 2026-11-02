import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createConfig} from '../src/core/config.js';
import {computeIncome,generateYear} from '../src/engine/income.js';

function fixture(absences=[]){
  const state=JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
  Object.assign(state.income,{plan_years:[{year:2026,salary_model:'percentage'}],salary_rates:[{id:'rate',effective_from:'2026-01-01',amount:223000,is_gross:true}],
    periods:[],vacations:absences.map(([start_date,end_date],i)=>({id:'v'+i,start_date,end_date,pay_manual:true,pay_amount:0})),sick_leaves:[],
    payout_slots:state.income.payout_slots.filter(s=>s.year===2026).map(s=>({...s,salary_percent:50})),tax_brackets:[{scale_id:'ndfl',sort_order:1,up_to:null,rate:13}]});
  const cfg=createConfig(state);state.income.periods=generateYear(state,cfg,2026);return {state,cfg};
}
test('процентный оклад: июль, август и сентябрь из примеров, окончательный расчёт сохраняет итог месяца',()=>{
  const {state,cfg}=fixture([['2026-07-06','2026-07-10'],['2026-09-20','2026-09-25']]);
  const income=computeIncome(state,cfg);
  for(const [month,advance,salary] of [['07',52912,98922],['08',97005,97005],['09',97005,52912]]){
    assert.equal(income.byId.get(`2026-${month}-1`).salary,advance,month);
    assert.equal(income.byId.get(`2026-${month}-2`).salary,salary,month);
  }
});
test('процентный оклад: реальные даты сентября исключают четыре рабочих дня',()=>{
  const {state,cfg}=fixture([['2026-09-20','2026-09-24']]);
  const income=computeIncome(state,cfg);
  assert.equal(income.byId.get('2026-09-2').salary,61731); // Округление начисления и НДФЛ по выплатам.
});
test('процентный оклад: ручной аванс и зафиксированная сумма засчитываются в остаток, разовые независимы',()=>{
  for(const locked of [false,true]){
    const {state,cfg}=fixture();const first=state.income.periods.find(p=>p.id==='2026-08-1');
    Object.assign(first,{income_net:100000,income_manual:!locked,locked});
    state.income.periods.push({id:'bonus',year:2026,calc_mode:'manual',taxable:false,income_net:10000,pay_date:'2026-08-25',window_start:'2026-08-01',window_end:'2026-08-31'});
    const income=computeIncome(state,cfg);
    assert.ok(Math.abs(income.byId.get('2026-08-2').salary-94010)<=1);
    assert.equal(income.byId.get('bonus').salary,10000);
  }
});
test('процентный оклад: незавершённый график не запускается; три выплаты и модель по дням',()=>{
  const {state,cfg}=fixture();state.income.payout_slots[0].salary_percent=40;
  assert.throws(()=>generateYear(state,cfg,2026),/100%/);
  assert.ok(computeIncome(state,cfg).byId.get('2026-08-1').formula.error);
  state.income.payout_slots=[{...state.income.payout_slots[0],salary_percent:30,window_to_day:10,pay_day:12},
    {...state.income.payout_slots[0],sort_order:3,salary_percent:30,window_from_day:11,window_to_day:20,pay_day:22},
    {...state.income.payout_slots[1],salary_percent:40,window_from_day:21}];
  state.income.periods=[];state.income.periods=generateYear(state,cfg,2026);
  const result=computeIncome(state,cfg);
  assert.equal(['1','3','2'].reduce((s,id)=>s+result.byId.get('2026-08-'+id).salary,0),194010);
  state.income.plan_years[0].salary_model='worked_days';
  assert.equal(computeIncome(state,cfg).byId.get('2026-08-1').formula.percentage,undefined);
});
test('процентный оклад: совпавшие даты выплат, полный отпуск и оклад на руки',()=>{
  const {state,cfg}=fixture([['2026-08-01','2026-08-15']]);
  state.income.salary_rates[0].is_gross=false;
  const first=state.income.periods.find(p=>p.id==='2026-08-1'),last=state.income.periods.find(p=>p.id==='2026-08-2');
  first.pay_date=last.pay_date;first.id='z-first';last.id='a-last';
  const income=computeIncome(state,cfg);
  assert.equal(income.byId.get('z-first').salary,0);
  assert.equal(income.byId.get('z-first').formula.windowDays,10);
  assert.equal(income.byId.get('a-last').salary,Math.round(223000*11/21));
});
test('процентный оклад: прогрессивный налог считается по годам фактических выплат',()=>{
  const {state,cfg}=fixture();
  state.income.tax_brackets=[{scale_id:'ndfl',sort_order:1,up_to:1000000,rate:13},{scale_id:'ndfl',sort_order:2,up_to:null,rate:15}];
  state.income.payout_slots[1].shift_rule='forward';
  state.income.periods=[];state.income.periods=generateYear(state,cfg,2026);
  const income=computeIncome(state,cfg);
  // В календарном 2026 году выплачивается 11,5 окладов, остаток декабря — в январе.
  assert.equal([...income.byId.values()].reduce((s,r)=>s+r.salary,0),2676000-364675-14495);
  state.income.payout_slots[0].salary_percent=-10;state.income.payout_slots[1].salary_percent=110;
  assert.ok(computeIncome(state,cfg).byId.get('2026-08-1').formula.error);
});
