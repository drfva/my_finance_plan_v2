import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/core/store.js';
import { deleteRow } from '../src/ui/edit.js';
const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const {PGlite}=await import(entry),{pgcrypto}=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('./000_supabase_stub.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../v2/install.sql',import.meta.url),'utf8'));
const user='aaaaaaaa-0000-0000-0000-000000000001';
await db.query("insert into auth.users(id,email) values($1,'history@example.test')",[user]);
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
await db.exec('set role authenticated');
const rpc=async(name,args={})=>(await db.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].data;
const account=(await rpc('bootstrap_user')).account.id;
await rpc('state_save',{p_domain:'expenses',p_account:account,p_patch:{expense_categories:[{id:'life',title:'Жизнь',monthly_amount:1000}],expense_items:[{id:'food',category_id:'life',title:'Еда',amount:1000}]}});
await rpc('state_save',{p_domain:'facts',p_account:account,p_patch:{expense_facts:[{ym:'2027-01',category_id:'life',item_key:'food',amount:950}]}});
const values=new Map(),historyStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
const client={async rpc(name,args){try{return {data:await rpc(name,args),error:null};}catch(e){return {data:null,error:e};}}};
const store=createStore({client,historyStorage,setTimer:()=>1,clearTimer(){}});await store.load();

test('БД: отмена удаления восстанавливает категорию, дочерние статьи и факты; запись переживает перезагрузку',async()=>{
  deleteRow(store,'expenses','expense_categories',{id:'life'});await store.flush();
  assert.equal(store.state.expenses.expense_categories.length,0);
  const history=store.history();assert.equal(history.length,1);
  await store.load();assert.equal(store.history()[0].id,history[0].id);
  await store.undoHistory(history[0].id);
  const state=await rpc('state_get',{p_account:account});
  assert.equal(state.expenses.expense_categories[0].monthly_amount,1000);
  assert.equal(state.expenses.expense_items[0].category_id,'life');
  assert.equal(state.facts.expense_facts[0].amount,950);
  assert.deepEqual(store.history(),[]);
  await store.load();assert.deepEqual(store.history(),[]);
});

test('БД: отмена не затирает изменение того же поля другим клиентом',async()=>{
  store.update('expenses',d=>{d.expense_categories[0].monthly_amount=1500;});await store.flush();
  const row={...store.state.expenses.expense_categories[0],monthly_amount:1700};
  await rpc('state_save',{p_domain:'expenses',p_account:account,p_patch:{expense_categories:[row]}});
  await assert.rejects(store.undoHistory(store.history()[0].id),/уже изменены/);
  assert.equal((await rpc('state_get',{p_account:account})).expenses.expense_categories[0].monthly_amount,1700);
  assert.equal(store.history()[0].undone,undefined);
});
test.after(async()=>{await db.close();});
