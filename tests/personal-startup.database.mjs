import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/core/store.js';
import { openPersonalPlan } from '../src/core/startup.js';

const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const {PGlite}=await import(entry),{pgcrypto}=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('000_supabase_stub.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../v2/install.sql',import.meta.url),'utf8'));
const A='aaaaaaaa-0000-0000-0000-000000000001',B='bbbbbbbb-0000-0000-0000-000000000002',C='cccccccc-0000-0000-0000-000000000003',D='dddddddd-0000-0000-0000-000000000004';
for(const [id,email] of [[A,'owner@example.test'],[B,'editor@example.test'],[C,'viewer@example.test'],[D,'family@example.test']])await db.query('insert into auth.users(id,email) values($1,$2)',[id,email]);
async function rpc(uid,name,args={},role='authenticated'){
  await db.exec('begin');try{
    await db.exec(`set local role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid??'']);
    const values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
    const result=await db.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,values);
    await db.exec('commit');return result.rows[0].data;
  }catch(error){await db.exec('rollback');throw error;}
}
const client=uid=>({async rpc(name,args){try{return {data:await rpc(uid,name,args),error:null};}catch(error){return {data:null,error};}}});
const shared=(await rpc(A,'bootstrap_user')).account.id;
for(const [email,role] of [['editor@example.test','editor'],['viewer@example.test','viewer']])await rpc(A,'add_account_member',{p_account:shared,p_email:email,p_role:role});
let mine;

test('личный план: доступ к чужому до первого входа не мешает создать свой, повторный вход не создаёт дубликат',async()=>{
  const c=client(B),store=createStore({client:c});await store.load({title:'Собственный план'});
  mine=store.state.account.id;
  assert.notEqual(mine,shared);assert.equal(store.state.account.role,'owner');assert.equal(store.state.account.plan_kind,'personal');
  assert.equal(store.state.accounts.find(a=>a.id===shared).role,'editor');
  await openPersonalPlan(store,c,shared);assert.equal(store.state.account.id,mine);
  assert.equal((await rpc(B,'bootstrap_user')).account.id,mine);
  assert.equal((await db.query("select count(*)::int n from public.accounts where created_by=$1 and plan_kind='personal'",[B])).rows[0].n,1);
});

test('личный план: переключение в общий и возврат в пустой собственный загружает правильные данные и права',async()=>{
  const c=client(B),store=createStore({client:c});await store.load();
  await store.switchAccount(shared);assert.equal(store.state.account.role,'editor');
  store.update('expenses',d=>{d.expense_categories.push({id:'shared-food',title:'Общая категория',mode:'fixed_month',monthly_amount:1000});});
  await store.flush();assert.equal(store.status(),'saved');
  await store.switchAccount(mine);assert.equal(store.state.account.id,mine);assert.equal(store.state.account.role,'owner');
  assert.equal(store.state.expenses.expense_categories.length,0);
  store.setAccountTitle('Мой отдельный план');await store.flush();assert.equal(store.status(),'saved');
  const fresh=createStore({client:c});await fresh.load();await openPersonalPlan(fresh,c,shared);
  assert.equal(fresh.state.account.id,mine);assert.equal(fresh.state.account.title,'Мой отдельный план');
  assert.notEqual((await rpc(A,'state_get',{p_account:shared})).account.title,'Мой отдельный план');
});

test('личный план: собственный открывается раньше чужого даже при роли владельца в обоих',async()=>{
  const own=(await rpc(C,'bootstrap_user')).account.id;assert.notEqual(own,shared);
  await rpc(A,'add_account_member',{p_account:shared,p_email:'viewer@example.test',p_role:'owner'});
  assert.equal((await rpc(C,'bootstrap_user')).account.id,own);
});

test('личный план: членство только в семье не заменяет свой план; чужая сессия и anon отклоняются',async()=>{
  const family=(await rpc(A,'family_command',{p_action:'create',p_family:null,p_payload:{title:'Семья'},p_version:null,p_request:crypto.randomUUID()})).family_id;
  await db.query("insert into public.account_members(account_id,user_id,role) values($1,$2,'owner')",[family,D]);
  await db.query("insert into public.family_members(family_id,user_id,email,nickname) values($1,$2,'family@example.test','Участник')",[family,D]);
  const own=(await rpc(D,'bootstrap_user')).account;
  assert.notEqual(own.id,family);assert.equal(own.plan_kind,'personal');assert.equal(own.role,'owner');
  await assert.rejects(rpc(D,'state_get',{p_account:mine}),/Нет доступа/);
  await assert.rejects(rpc(null,'bootstrap_user'),/Нужно войти/);
  await assert.rejects(rpc(null,'bootstrap_user',{},'anon'),/permission denied/);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261102084138_personal_plan_startup.sql',import.meta.url),'utf8').replace(/\r?\n/g,'\r\n'));
  assert.equal((await rpc(B,'bootstrap_user')).account.id,mine);
});

test.after(async()=>{await db.close();});
