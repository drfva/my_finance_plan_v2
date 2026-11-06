import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createStore} from '../src/core/store.js';
import {createTracker,progressOf} from '../src/engine/savings.js';
const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const {PGlite}=await import(entry),{pgcrypto}=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('./000_supabase_stub.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../v2/install.sql',import.meta.url),'utf8'));
const user='aaaaaaaa-0000-0000-0000-000000000001';
await db.query("insert into auth.users(id,email) values($1,'goals@example.test')",[user]);
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
const rpc=async(name,args={})=>(await db.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].data;
const account=(await rpc('bootstrap_user')).account.id;
const save=patch=>rpc('state_save',{p_domain:'savings',p_account:account,p_patch:patch});
const get=()=>rpc('state_get',{p_account:account});
const goals=[{id:'trip',title:'Путешествия',target_amount:100000,starting_balance:20000},{id:'other',title:'Другая цель'}];
const stages=[{id:'y2027',goal_id:'trip',title:'2027',target:100000,deadline:'2027-04-01'},{id:'foreign',goal_id:'other',title:'Чужой этап',target:10000}];
const purchase={id:'tickets',goal_id:'trip',date:'2026-12-30',kind:'spend',amount:10000,purpose:'goal',milestone_id:'y2027'};
test('БД: старые траты получают other, новая покупка сохраняет назначение и этап',async()=>{
 await save({goals,goal_milestones:stages,goal_transactions:[{id:'old',goal_id:'trip',date:'2026-12-29',kind:'spend',amount:1000},purchase]});
 const state=await get();assert.equal(state.savings.goal_transactions.find(t=>t.id==='old').purpose,'other');assert.equal(state.savings.goal_transactions.find(t=>t.id==='tickets').milestone_id,'y2027');
});
test('БД: нельзя засчитать покупку в этап другой цели или без этапа при их наличии',async()=>{
 await assert.rejects(save({goal_transactions:[{...purchase,milestone_id:'foreign'}]}),/этап этой же копилки/);
 await assert.rejects(save({goal_transactions:[{...purchase,milestone_id:null}]}),/этап этой же копилки/);
 assert.equal((await get()).savings.goal_transactions.find(t=>t.id==='tickets').milestone_id,'y2027');
});
test('БД: перенос покупки и замена этапа разрешены одним атомарным патчем',async()=>{
 await save({goal_milestones:[{...stages[0],id:'renamed'},stages[1]],goal_transactions:[{...purchase,milestone_id:'renamed'}]});
 assert.equal((await get()).savings.goal_transactions[0].milestone_id,'renamed');
 await assert.rejects(save({goal_milestones:[stages[1]]}),/этап этой же копилки/);
 assert.ok((await get()).savings.goal_milestones.some(m=>m.id==='renamed'));
});
test('БД: цель без этапов принимает покупку без связи; пополнение не может быть покупкой',async()=>{
 await save({goal_transactions:[{...purchase,milestone_id:null}],goal_milestones:[]});
 assert.equal((await get()).savings.goal_transactions[0].purpose,'goal');
 await assert.rejects(save({goal_transactions:[{...purchase,milestone_id:null,kind:'deposit'}]}),/purpose_check/);
});
test('БД: отмена редактирования назначения возвращает прежний расчёт и удаляет запись',async()=>{
 const storage=new Map(),client={async rpc(name,args){try{return {data:await rpc(name,args),error:null};}catch(e){return {data:null,error:e};}}};
 const store=createStore({client,historyStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},setTimer:()=>1,clearTimer(){}});await store.load();
 store.update('savings',s=>{s.goal_transactions[0].purpose='other';});await store.flush();assert.equal((await get()).savings.goal_transactions[0].purpose,'other');
 await store.undoHistory(store.history()[0].id);assert.equal((await get()).savings.goal_transactions[0].purpose,'goal');assert.deepEqual(store.history(),[]);
});
test('БД: миграция повторяема, функции не обходят RLS',async()=>{
 await db.exec('reset role');
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261106100556_goal_spending_purpose.sql',import.meta.url),'utf8'));
 const security=(await db.query("select p.prosecdef,c.relrowsecurity from pg_proc p cross join pg_class c where p.proname='check_goal_purchase_stage' and c.oid='public.goal_transactions'::regclass")).rows[0];
 assert.equal(security.prosecdef,false);assert.equal(security.relrowsecurity,true);
 await db.exec('set role authenticated');assert.equal((await get()).savings.goal_transactions[0].purpose,'goal');
});
test('БД: ручной снимок закрытия сохраняет необеспеченную часть покупки без новой миграции',async()=>{
 const operation={...purchase,amount:100000,milestone_id:null};
 const tracker=createTracker({goals:[goals[0]],milestones:[]});tracker.apply(operation);
 const phase=tracker.phase('trip'),snapshot={date:operation.date,phase,progress:progressOf([{target:100000}],phase),milestones:[{id:'_main',date:tracker.milestoneDates().trip[0]}]};
 await save({goals:[{...goals[0],completed:true,completion_snapshot:snapshot},goals[1]],goal_transactions:[operation]});
 const stored=(await get()).savings.goals.find(g=>g.id==='trip').completion_snapshot;
 assert.equal(stored.progress,20000);assert.deepEqual(stored.phase.purchaseDebt,[80000]);assert.equal(stored.milestones[0].date,null);
});
test.after(async()=>db.close());
