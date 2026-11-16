import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { baseExpenseFacts, expenseFactRows, trackedFacts } from '../src/ui/expense-tracking.js';
import { postIncomeForPlan } from '../src/core/income-deposit-worker.js';

const entry = process.env.FINANCE_PGLITE_MODULE ? pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href : '@electric-sql/pglite';
const { PGlite } = await import(entry);
const { pgcrypto } = await import(process.env.FINANCE_PGLITE_MODULE ? new URL('contrib/pgcrypto.js',entry).href : '@electric-sql/pglite/contrib/pgcrypto');
const db = new PGlite({ extensions: { pgcrypto } });
test.after(() => db.close());
await db.exec('create role service_role nologin bypassrls');
for (const file of ['./000_supabase_stub.sql','../v2/install.sql']) {
  await db.exec(await fs.readFile(new URL(file,import.meta.url),'utf8'));
}
const owner = crypto.randomUUID(), outsider = crypto.randomUUID();
await db.query("insert into auth.users (id,email) values ($1,'owner@example.test'),($2,'outsider@example.test')", [owner,outsider]);
await db.exec('set role authenticated');
const setActor = id => db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
await setActor(owner);
async function rpc(name,args = {}) {
  const keys = Object.keys(args), values = Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  const query = 'select public.' + name + '(' + keys.map((k,i)=>k+' => $'+(i+1)).join(',') + ') as data';
  return (await db.query(query,values)).rows[0].data;
}
const today = (await db.query("select to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD') as d")).rows[0].d;
const previous = (await db.query("select to_char(date_trunc('month',now() at time zone 'Europe/Moscow') - interval '1 day','YYYY-MM-DD') as d")).rows[0].d;
const plan = (await rpc('bootstrap_user',{p_title:'Тестовый план'})).account.id;
const get = () => rpc('expense_tracking_get',{p_plan:plan});
const command = (p_action,p_payload,p_revision = null) => rpc('expense_tracking_command',{p_plan:plan,p_action,p_payload,p_revision});
const override = (p_plan,p_month,p_category,p_amount,p_previous=null,p_item) => rpc('expense_tracking_set_category_fact',{
  p_plan,p_month,p_category,p_amount,p_previous,...(p_item ? {p_item} : {}),
});
const card = crypto.randomUUID(), cash = crypto.randomUUID(), purchase = crypto.randomUUID();
const fact = [{ym:previous.slice(0,7),category_id:'food',item_key:'',amount:8000,category_title:'Еда'}];
const todayFact = {ym:today.slice(0,7),category_id:'food',item_key:'',amount:1200,category_title:'Еда'};
for (const [domain,patch] of [['expenses',{expense_categories:[{id:'food',title:'Еда'}]}],['facts',{expense_facts:[...fact,todayFact]}]]) {
  await rpc('state_save',{p_domain:domain,p_account:plan,p_patch:patch});
}
let state;
const buy = { id:purchase,date:today,category_id:'food',amount:3000,tags:['Дом','Выходные','Дом'],
  parts:[{account_id:card,amount:2000},{account_id:cash,amount:1000}] };
const balance = id => state.accounts.find(a => a.id === id).balance;

test('запуск, атомарная покупка и фильтрация по частям оплаты',async()=>{
  assert.deepEqual(await get(),{enabled:false,fact_items_supported:true,fact_overrides:[]});
  await assert.rejects(command('enable',{id:card,title:'',amount:40000,date:today,fact_mode:'reset'}));
  assert.deepEqual(await get(),{enabled:false,fact_items_supported:true,fact_overrides:[]});
  state = await command('enable',{id:card,title:'Карта',amount:40000,date:today,fact_mode:'reset'});
  assert.equal(state.settings.deposit_account,card);
  state = await command('account_add',{id:cash,title:'Наличные',amount:500,date:today},state.settings.revision);
  const before = state;
  await assert.rejects(command('purchase_save',{...buy,parts:[{account_id:card,amount:2000}]},state.settings.revision),/Части оплаты/);
  assert.deepEqual(await get(),before);
  state = await command('purchase_save',buy,state.settings.revision);
  assert.equal(balance(card),38000);
  assert.equal(balance(cash),-500);
  assert.equal(state.purchases.length,1);
  assert.equal(state.purchases[0].parts.find(p=>p.account_id===card).amount,2000);
  assert.deepEqual(state.purchases[0].tags,['Выходные','Дом']);
  assert.equal(trackedFacts({tracking:state},[...fact,todayFact]).find(f=>f.ym===today.slice(0,7)).amount,3000);
});

test('перенос и удаление покупки восстанавливают остатки и ручной факт',async()=>{
  await assert.rejects(command('purchase_save',buy,0),/другой вкладке/);
  state = await command('purchase_save',{...buy,date:previous,included_in_fact:true},state.settings.revision);
  assert.equal(balance(card),40000);
  assert.equal(balance(cash),500);
  assert.equal(trackedFacts({tracking:state},fact)[0].amount,8000);
  state = await command('purchase_delete',{id:purchase},state.settings.revision);
  assert.deepEqual(state.purchases,[]);
  assert.equal(trackedFacts({tracking:state},fact)[0].amount,8000);
});

test('перевод изменяет два счета, посторонний не может читать или писать',async()=>{
  state = await command('movement_add',{id:crypto.randomUUID(),date:today,from_account:card,to_account:cash,amount:100},state.settings.revision);
  assert.equal(balance(card),39900);
  assert.equal(balance(cash),600);
  await setActor(outsider);
  try {
    await assert.rejects(get(),/Нет доступа/);
    await assert.rejects(command('purchase_save',buy,state.settings.revision),/Нет доступа/);
  } finally { await setActor(owner); }
});

test('семья включает свой журнал отдельно и добавляет покупку к ручному факту',async()=>{
  const result = await rpc('family_command',{p_action:'create',p_family:null,p_payload:{title:'Тестовая семья'},
    p_version:null,p_request:crypto.randomUUID()});
  const family = result.family_id;
  const household = (action,payload,revision = null) => rpc('expense_tracking_command',{
    p_plan:family,p_action:action,p_payload:payload,p_revision:revision,
  });
  const familyCommand = async (action,payload) => {
    const before = await rpc('family_get',{p_family:family});
    return rpc('family_command',{p_action:action,p_family:family,p_payload:payload,
      p_version:before.version,p_request:crypto.randomUUID()});
  };
  await familyCommand('category',{id:'food',title:'Еда'});
  await familyCommand('fact',{category_id:'food',month:today.slice(0,7),amount:8000});
  const id = crypto.randomUUID();
  const started = await household('enable',{id,title:'Общий счет',date:today,amount:5000,fact_mode:'add'});
  const familyPurchase = {id:crypto.randomUUID(),date:today,category_id:'food',amount:2000,
    parts:[{account_id:id,amount:2000}]};
  await assert.rejects(household('purchase_save',{...familyPurchase,parts:[{account_id:card,amount:2000}]},started.settings.revision),/Части оплаты/);
  const next = await household('purchase_save',familyPurchase,started.settings.revision);
  const manual = (await rpc('family_get',{p_family:family})).expense_facts;
  assert.equal(trackedFacts({tracking:next},manual,true)[0].amount,10000);
  assert.equal(next.accounts[0].balance,3000);
  await familyCommand('category',{id:'fruit',title:'Фрукты',parent_id:'food'});
  await familyCommand('fact',{category_id:'fruit',month:today.slice(0,7),amount:1000});
  const report = await rpc('family_get',{p_family:family});
  const fixed = await override(family,today.slice(0,7),'food',7000);
  const ctx = {tracking:fixed,state:{family:report}};
  assert.deepEqual(trackedFacts(ctx,report.expense_facts,true).map(f=>[f.category_id,f.amount]),[['food',7000]]);
  assert.equal(baseExpenseFacts(ctx,report.expense_facts,true).find(f=>f.category_id==='fruit').amount,1000);
  assert.deepEqual(fixed.accounts,next.accounts);
  const itemOverride = await override(family,today.slice(0,7),'food',2000,null,'fruit');
  const edited = expenseFactRows({...ctx,tracking:itemOverride},report.expense_facts,true);
  assert.equal(edited.details.find(f=>f.category_id==='fruit').amount,2000);
  assert.deepEqual(edited.totals.map(f=>[f.category_id,f.amount]),[['food',7000]]);
  const restored = await override(family,today.slice(0,7),'food',null,7000);
  assert.equal(trackedFacts({...ctx,tracking:restored},report.expense_facts,true).reduce((n,f)=>n+f.amount,0),12000);
  assert.equal((await get()).purchases.length,0);
});

test('итоги подкатегорий складываются, ручной итог категории имеет приоритет',async()=>{
  const month = today.slice(0,7);
  await rpc('state_save',{p_account:plan,p_domain:'expenses',p_patch:{expense_items:[
    {id:'bread',category_id:'food',title:'Хлеб'}, {id:'fruit',category_id:'food',title:'Фрукты'},
  ]}});
  const prior = await get();
  await command('purchase_save',{...buy,item_id:'bread'},prior.settings.revision);
  await assert.rejects(override(plan,month,'food',1000,null,'missing'),/подкатегория плана не найдена/);
  await override(plan,month,'food',3500,null,'bread');
  const withChildren = await override(plan,month,'food',500,null,'fruit');
  const monthly = tracking => trackedFacts({tracking},fact).filter(f=>f.ym===month).reduce((sum,f)=>sum+f.amount,0);
  assert.equal(monthly(withChildren),4000);
  const withParent = await override(plan,month,'food',4200);
  assert.equal(monthly(withParent),4200);
  assert.equal(expenseFactRows({tracking:withParent},fact).details.find(f=>f.item_key==='bread').amount,3500);
  const withoutParent = await override(plan,month,'food',null,4200);
  assert.equal(monthly(withoutParent),4000);
  const withoutBread = await override(plan,month,'food',null,3500,'bread');
  assert.equal(monthly(withoutBread),3500);
  assert.deepEqual(withoutBread.purchases,withChildren.purchases);
});

test('корректировка начального остатка меняет баланс с текущей даты и сохраняет движения',async()=>{
  const before = await get();
  const initial = before.accounts.find(a=>a.id===card);
  const changed = await command('account_edit',{id:card,title:'Карта для покупок',amount:41000},before.settings.revision);
  const account = changed.accounts.find(a=>a.id===card);
  assert.equal(account.title,'Карта для покупок');
  assert.equal(account.opening_amount,40000);
  assert.equal(account.adjusted_opening_amount,41000);
  assert.equal(account.balance,initial.balance+1000);
  assert.deepEqual(changed.movements,before.movements);
  assert.deepEqual(changed.corrections.find(c=>c.account_id===card),{account_id:card,effective_on:today,delta:1000});
  const again = await command('account_edit',{id:card,title:'Та же карта',amount:40500},changed.settings.revision);
  assert.equal(again.accounts.find(a=>a.id===card).balance,initial.balance+500);
  assert.equal(again.corrections.find(c=>c.account_id===card).delta,500);
});

test('личные выплаты проводятся один раз по дате, смена счёта переносит исходную сумму',async()=>{
  const stateBefore = await get();
  const beforeOn = id => stateBefore.accounts.find(a=>a.id===id).balance;
  const { tomorrow, month_end:monthEnd } = (await db.query(`select
    ((now() at time zone 'Europe/Moscow')::date+1)::text as tomorrow,
    (date_trunc('month',now() at time zone 'Europe/Moscow')+interval '1 month - 1 day')::date::text as month_end`)).rows[0];
  const manual = (id,pay_date,income_net)=>({id,year:Number(pay_date.slice(0,4)),pay_date,window_start:pay_date,
    window_end:pay_date,calc_mode:'manual',income_net,income_manual:true,taxable:false,title:'Разовая выплата'});
  const periods = [manual('prior',previous,5000),manual('bonus',today,12000),manual('future',tomorrow,25000),
    {...manual('salary',today,0),title:'Оклад',calc_mode:'auto',taxable:true,income_manual:false,
      window_start:today.slice(0,7)+'-01',window_end:monthEnd}];
  await rpc('state_save',{p_account:plan,p_domain:'income',p_patch:{periods,
    salary_rates:[{id:'salary-rate',effective_from:today.slice(0,7)+'-01',amount:100000,is_gross:false}]}});
  const choose = (period,account,revision) => rpc('expense_tracking_set_income_account',{
    p_plan:plan,p_period:period,p_account:account,p_revision:revision,
  });
  await assert.rejects(choose('prior',cash,stateBefore.settings.revision),/вне периода/);
  let changed = await choose('bonus',cash,stateBefore.settings.revision);
  changed = await choose('future',cash,changed.settings.revision);
  assert.equal(changed.accounts.find(a=>a.id===cash).balance,beforeOn(cash));
  await assert.rejects(rpc('expense_income_worker_read',{p_plan:plan}),/permission denied/);
  await db.exec('set role service_role');
  try {
    assert.equal(await postIncomeForPlan(rpc,plan),2);
    assert.equal(await postIncomeForPlan(rpc,plan),0);
  } finally { await db.exec('set role authenticated'); }
  changed = await get();
  assert.equal(changed.income_receipts.bonus?.amount,12000);
  assert.equal(changed.income_receipts.bonus?.paid_on,today);
  assert.equal(changed.income_receipts.salary?.amount,100000);
  assert.equal(changed.income_receipts.future?.paid_on,null);
  assert.equal(changed.income_receipts.prior,undefined);
  assert.equal(changed.accounts.find(a=>a.id===card).balance,beforeOn(card)+100000);
  assert.equal(changed.accounts.find(a=>a.id===cash).balance,beforeOn(cash)+12000);
  await setActor(outsider);
  await assert.rejects(choose('bonus',card,changed.settings.revision),/Нет доступа/);
  await setActor(owner);
  const revised = await choose('bonus',card,changed.settings.revision);
  assert.equal(revised.income_receipts.bonus.amount,12000);
  assert.equal(revised.income_receipts.bonus.paid_on,today);
  assert.equal(revised.settings.deposit_account,card);
  assert.equal(revised.accounts.find(a=>a.id===card).balance,beforeOn(card)+112000);
  assert.equal(revised.accounts.find(a=>a.id===cash).balance,beforeOn(cash));
  assert.equal(revised.income_account_changes[0].from_account,cash);
  assert.equal(revised.income_account_changes[0].to_account,card);
  assert.equal((await choose('bonus',card,revised.settings.revision)).income_account_changes.length,1);
});

test('ручной итог заменяет сумму категории за месяц и сбрасывается без изменения журнала',async()=>{
  const month = today.slice(0,7);
  const initial = await get();
  const original = await command('purchase_save',buy,initial.settings.revision);
  const saved = await override(plan,month,'food',5000);
  assert.deepEqual(saved.accounts,original.accounts);
  assert.deepEqual(saved.purchases,original.purchases);
  const amount = tracking => trackedFacts({tracking},fact).find(f=>f.ym===month)?.amount;
  assert.equal(amount(saved),5000);
  assert.equal(trackedFacts({tracking:saved},fact).find(f=>f.ym!==month).amount,8000);
  await assert.rejects(override(plan,month,'food',4500),/уже изменился/);
  const zero = await override(plan,month,'food',0,5000);
  assert.equal(amount(zero),0);
  const restored = await override(plan,month,'food',null,0);
  assert.equal(amount(restored),3000);
  await setActor(outsider);
  try { await assert.rejects(override(plan,month,'food',5000),/Нет доступа/); }
  finally { await setActor(owner); }
});
