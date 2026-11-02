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
const account=(await rpc(A,'bootstrap_user')).account.id;
test('SQL: процентная модель сохраняется и читается, превышение 100% откатывается',async()=>{
  let state=await rpc(A,'state_get',{p_account:account});
  const slots=[{year:2026,sort_order:1,title:'Аванс',pay_day:20,window_from_day:1,window_to_day:15,salary_percent:50},
    {year:2026,sort_order:2,title:'Зарплата',pay_day:5,month_offset:1,window_from_day:16,window_to_day:31,salary_percent:50}];
  await rpc(A,'state_save',{p_account:account,p_domain:'income',p_version:state.versions.income,p_patch:{plan_years:[{year:2026,salary_model:'percentage'}],payout_slots:slots}});
  state=await rpc(A,'state_get',{p_account:account});
  assert.equal(state.income.plan_years[0].salary_model,'percentage');
  assert.equal(state.income.payout_slots[0].salary_percent,50);
  await assert.rejects(rpc(A,'state_save',{p_account:account,p_domain:'income',p_version:state.versions.income,p_patch:{payout_slots:slots.map((s,i)=>({...s,salary_percent:i?50:60}))}}),/100%/);
  assert.equal((await rpc(A,'state_get',{p_account:account})).income.payout_slots[0].salary_percent,50);
  await assert.rejects(rpc(B,'state_save',{p_account:account,p_domain:'income',p_version:state.versions.income,p_patch:{plan_years:[{year:2026,salary_model:'percentage'}]}}),/Нет доступа/);
});
test.after(async()=>{await db.close();});
