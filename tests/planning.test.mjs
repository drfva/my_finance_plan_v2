import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { changesBetween,reverseChanges,localPlanData } from '../src/core/plan-history.js';
import { applyScenario } from '../src/engine/scenarios.js';
import { comparePlans,forecastChanges } from '../src/engine/plan-compare.js';
import { render as renderPlanning, handle as handlePlanning,changeExplanation } from '../src/ui/planning.js';
import { createConfig } from '../src/core/config.js';
import { createStore } from '../src/core/store.js';

function source(){
  const s=JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
  s.account.can_edit=true;s.account.plan_kind='personal';s.account.id='a';s.user.id='u';
  s.settings.account_settings={};s.settings.fx_rates=[];s.income={periods:['2027-01-05','2027-01-20','2027-02-05','2027-02-20'].map((date,i)=>({id:`p${i}`,year:2027,pay_date:date,window_start:date,window_end:date,calc_mode:'manual',income_manual:true,income_net:5000}))};
  s.expenses={expense_categories:[{id:'life',title:'Жизнь',mode:'fixed_month',monthly_amount:1000,split_mode:'even'}],expense_items:[],expense_period_overrides:[]};
  s.debts={};s.gifts={};s.facts={};s.savings={goals:[{id:'trip',title:'Поездка',kind_code:'bucket',currency_code:'RUB',target_amount:10000,deadline:'2027-02-28'},
    {id:'reserve',title:'Подушка',kind_code:'reserve',currency_code:'RUB',target_amount:100000,pace_amount:500}]};
  return s;
}
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};};

test('сценарий: +500 расходов в месяц меняет только копию и объясняет уменьшение подушки',()=>{
  const state=source(),original=structuredClone(state);
  const result=applyScenario(state,{adjustments:[{type:'expense',target:'life',amount:500,from:'2027-01-01'}]},'2026-11-04');
  assert.deepEqual(state,original);
  const comparison=comparePlans(state,result.state,'2026-11-04'),changes=forecastChanges(comparison,2027);
  assert.equal(changes.find(c=>c.title==='Расходы и обязательные платежи').delta,1000);
  assert.equal(changes.find(c=>c.title==='В подушки').delta,-1000);
  assert.ok(!changes.some(c=>c.kind==='date'&&c.title==='Поездка'));
});

test('сценарий: снижение дохода, покупка и новый курс; закреплённая выплата сохраняется',()=>{
  const state=source();state.income.periods[0].locked=true;
  const income=applyScenario(state,{adjustments:[{type:'income',amount:-1000,from:'2027-01-01'}]},'2026-11-04');
  assert.equal(income.state.income.periods[0].income_net,5000);
  assert.equal(income.state.income.periods[1].income_net,4000);
  assert.equal(income.state.income.periods[2].income_net,4500);
  const purchase=applyScenario(state,{adjustments:[{type:'purchase',amount:2000,from:'2027-02-10'}]},'2026-11-04');
  assert.equal(purchase.state.expenses.expense_period_overrides[0].period_id,'p2');
  assert.equal(purchase.state.expenses.expense_period_overrides[0].amount,2000);
  state.settings.fx_rates=[{base_code:'RUB',quote_code:'USD',rate_date:'2026-11-04',rate:100}];
  const fx=applyScenario(state,{adjustments:[{type:'fx',target:'USD',amount:10}]},'2026-11-04');
  assert.ok(Math.abs(fx.state.current_fx.rates[0].rate-110)<1e-9);
  assert.throws(()=>applyScenario(state,{adjustments:[{type:'fx',target:'USD',amount:-100}]},'2026-11-04'));
});

test('отмена: восстановление связанных удалений и защита изменённых полей',()=>{
  const before=source();before.expenses.expense_items=[{id:'food',category_id:'life',title:'Еда',amount:1000}];
  const after=structuredClone(before);after.expenses.expense_categories=[];after.expenses.expense_items=[];
  const entry={changes:changesBetween(before,after)};
  assert.deepEqual(reverseChanges(after,entry).state.expenses,before.expenses);
  const edited=structuredClone(before);edited.expenses.expense_categories[0].monthly_amount=1500;
  const change={changes:changesBetween(before,edited)};
  edited.expenses.expense_categories[0].title='Новое имя';
  assert.equal(reverseChanges(edited,change).state.expenses.expense_categories[0].title,'Новое имя');
  edited.expenses.expense_categories[0].monthly_amount=1700;
  assert.throws(()=>reverseChanges(edited,change),/уже изменены/);
});

test('локальное хранилище: сценарии разделены по пользователю и плану',()=>{
  const data=storage(),state=source();localPlanData(state,'scenarios',data).write([{name:'Мой сценарий'}]);
  assert.equal(localPlanData(state,'scenarios',data).read().length,1);
  state.account.id='b';assert.deepEqual(localPlanData(state,'scenarios',data).read(),[]);
  state.account.id='a';state.user.id='other';assert.deepEqual(localPlanData(state,'scenarios',data).read(),[]);
});

test('отмена JSON-полей: порядок ключей после сохранения в jsonb не создаёт ложный конфликт',()=>{
  const before=source();before.expenses.expense_categories[0].amount_seasons=[];
  const after=structuredClone(before);
  after.expenses.expense_categories[0].amount_seasons=[{from:'2027-01-01',to:'2027-12-31',amount:1500}];
  const entry={changes:changesBetween(before,after)},server=structuredClone(after);
  server.expenses.expense_categories[0].amount_seasons=[{amount:1500,to:'2027-12-31',from:'2027-01-01'}];
  assert.deepEqual(reverseChanges(server,entry).state.expenses.expense_categories[0].amount_seasons,[]);
});

test('история: перезагрузка, группировка зависимых правок, отмена и сохранение несвязанных полей сервера',async()=>{
  let server=source();const data=storage();
  const client={async rpc(name,args){
    if(name==='state_save'){
      Object.assign(server[args.p_domain],structuredClone(args.p_patch));
      return {data:{version:1,tables:structuredClone(args.p_patch)},error:null};
    }
    return {data:structuredClone(server),error:null};
  }};
  const store=createStore({client,historyStorage:data,setTimer:()=>1,clearTimer(){}});await store.load();
  store.update('expenses',d=>{d.expense_categories[0].monthly_amount=1500;});
  store.update('facts',d=>{d.expense_facts=[{ym:'2027-01',category_id:'life',item_key:'',amount:1500}];});
  await store.flush();assert.equal(store.history().length,1);assert.equal(store.history()[0].changes.length,2);
  await store.load();assert.equal(store.history().length,1);
  server.expenses.expense_categories[0].title='Другая правка';
  await store.undoHistory(store.history()[0].id);
  assert.equal(server.expenses.expense_categories[0].monthly_amount,1000);
  assert.equal(server.expenses.expense_categories[0].title,'Другая правка');
  assert.equal(server.facts.expense_facts.length,0);
  assert.equal(store.history()[0].undone,true);
  store.withoutHistory(()=>store.update('income',d=>{d.system_marker=true;}));
  await Promise.resolve();assert.equal(store.history().length,1);
});

test('интерфейс сценария: безопасный предпросмотр, объяснение и отсутствие доступа к отмене у читателя',()=>{
  const state=source(),cfg=createConfig(state),ctx={state,cfg,fmt:cfg.formatter(),today:'2026-11-04',year:2027,
    canEdit:false,ui:{draft:{},open:new Set()},store:{history:()=>[],lastHistory:()=>null}};
  const ev={target:{closest:s=>s==='[data-scenario-new]'?{}:null}};
  assert.equal(handlePlanning(ev,ctx),true);
  const html=renderPlanning(ctx);assert.match(html,/Сравнение за 2027/);assert.match(html,/основной план/i);
  assert.doesNotMatch(html,/data-history-undo/);
  assert.equal(changeExplanation(ctx),'');
});

test('история: конфликт версии во время отмены не помечает действие отменённым',async()=>{
  let server=source(),conflict=false;
  const client={async rpc(name,args){
    if(name==='state_save'){
      if(conflict){server.expenses.expense_categories[0].monthly_amount=1700;return {error:{code:'PT409',message:'Конфликт'},status:409};}
      Object.assign(server[args.p_domain],structuredClone(args.p_patch));return {data:{version:1,tables:structuredClone(args.p_patch)}};
    }
    return {data:structuredClone(server)};
  }};
  const store=createStore({client,historyStorage:storage(),setTimer:()=>1,clearTimer(){}});await store.load();
  store.update('expenses',d=>{d.expense_categories[0].monthly_amount=1500;});await store.flush();
  conflict=true;
  await assert.rejects(store.undoHistory(store.history()[0].id),/другой вкладке/);
  assert.equal(store.history()[0].undone,undefined);
  assert.equal(server.expenses.expense_categories[0].monthly_amount,1700);
});
