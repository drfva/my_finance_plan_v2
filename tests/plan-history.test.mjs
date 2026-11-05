import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { changesBetween,reverseChanges,localPlanData } from '../src/core/plan-history.js';
import { comparePlans,forecastChanges } from '../src/engine/plan-compare.js';
import {createChangeToast,renderChangeToast} from '../src/ui/plan-changes.js';
import {createConfig} from '../src/core/config.js';
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

test('объяснение правки: +500 расходов в месяц уменьшает накопление в подушку',()=>{
  const state=source(),after=structuredClone(state);
  after.expenses.expense_categories[0].monthly_amount+=500;
  const comparison=comparePlans(state,after,'2026-11-04'),changes=forecastChanges(comparison,2027);
  assert.equal(changes.find(c=>c.title==='Расходы и обязательные платежи').delta,1000);
  assert.equal(changes.find(c=>c.title==='В подушки').delta,-1000);
  assert.ok(!changes.some(c=>c.kind==='date'&&c.title==='Поездка'));
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

test('локальное хранилище: история разделена по пользователю и плану',()=>{
  const data=storage(),state=source();localPlanData(state,'history',data).write([{name:'Моя правка'}]);
  assert.equal(localPlanData(state,'history',data).read().length,1);
  state.account.id='b';assert.deepEqual(localPlanData(state,'history',data).read(),[]);
  state.account.id='a';state.user.id='other';assert.deepEqual(localPlanData(state,'history',data).read(),[]);
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
  const added=[];store.subscribe(event=>{if(event.type==='history'&&event.entry)added.push(event.entry.id);});
  store.update('expenses',d=>{d.expense_categories[0].monthly_amount=1500;});
  store.update('facts',d=>{d.expense_facts=[{ym:'2027-01',category_id:'life',item_key:'',amount:1500}];});
  await store.flush();assert.equal(store.history().length,1);assert.equal(store.history()[0].changes.length,2);
  await store.load();assert.equal(store.history().length,1);
  server.expenses.expense_categories[0].title='Другая правка';
  await store.undoHistory(store.history()[0].id);
  assert.equal(server.expenses.expense_categories[0].monthly_amount,1000);
  assert.equal(server.expenses.expense_categories[0].title,'Другая правка');
  assert.equal(server.facts.expense_facts.length,0);
  assert.deepEqual(store.history(),[]);
  await store.load();assert.deepEqual(store.history(),[]);
  assert.equal(added.length,1,'отмена не создаёт новое уведомление о старой правке');
  store.withoutHistory(()=>store.update('income',d=>{d.system_marker=true;}));
  await Promise.resolve();assert.equal(store.history().length,0);
});

test('уведомление: исчезает через 3 секунды, новая правка перезапускает таймер',()=>{
  let next=0;const timers=new Map(),seen=[];
  const toast=createChangeToast({setTimer:(fn,delay)=>{assert.equal(delay,3000);timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id),onChange:e=>seen.push(e)});
  toast.show({id:'first'});toast.show({id:'second'});
  assert.equal(timers.has(1),false);assert.equal(toast.entry.id,'second');
  timers.get(2)();assert.equal(toast.entry,null);assert.equal(seen.at(-1),null);
});

test('уведомление: показывает изменение и ссылку в историю нужного года',()=>{
  const state=source(),after=structuredClone(state),cfg=createConfig(state);
  after.expenses.expense_categories[0].monthly_amount+=500;
  const html=renderChangeToast({state,year:2027,fmt:cfg.formatter()},{label:'Изменено: Жизнь',comparison:comparePlans(state,after,'2026-11-04')});
  assert.match(html,/role="status"/);assert.match(html,/data-open-plan-history="2027"/);
  assert.match(html,/Изменено: Жизнь/);assert.match(html,/Открыть историю изменений/);
});

test('история: конфликт версии во время отмены сохраняет запись',async()=>{
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

test('история: ошибка сохранения оставляет запись, успешный повтор удаляет её',async()=>{
  let server=source(),offline=false;
  const client={async rpc(name,args){
    if(name==='state_save'){
      if(offline)return {error:{message:'offline'}};
      Object.assign(server[args.p_domain],structuredClone(args.p_patch));return {data:{version:1,tables:structuredClone(args.p_patch)}};
    }return {data:structuredClone(server)};
  }};
  const store=createStore({client,historyStorage:storage(),setTimer:()=>1,clearTimer(){}});await store.load();
  store.update('expenses',d=>{d.expense_categories[0].monthly_amount=1500;});await store.flush();
  const id=store.history()[0].id;offline=true;
  await assert.rejects(store.undoHistory(id),/Не удалось сохранить отмену/);
  assert.equal(store.history()[0].id,id);assert.equal(server.expenses.expense_categories[0].monthly_amount,1500);
  offline=false;await store.undoHistory(id);
  assert.deepEqual(store.history(),[]);assert.equal(server.expenses.expense_categories[0].monthly_amount,1000);
});

test('история: ранее отменённые записи удаляются и из сохранённого журнала',async()=>{
  const state=source(),data=storage();
  localPlanData(state,'history',data).write([{id:'old',undone:true,changes:[]},{id:'active',changes:[]}]);
  const store=createStore({client:{rpc:async()=>({data:structuredClone(state)})},historyStorage:data});await store.load();
  assert.deepEqual(store.history().map(e=>e.id),['active']);
  assert.deepEqual(localPlanData(state,'history',data).read().map(e=>e.id),['active']);
});
