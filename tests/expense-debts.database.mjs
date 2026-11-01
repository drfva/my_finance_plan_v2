import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createConfig } from '../src/core/config.js';
import { simulate, freezePeriods } from '../src/engine/allocation.js';
import { runFamilyMember } from '../src/core/family-worker.js';
import { addDays } from '../src/engine/dates.js';
const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const { PGlite }=await import(entry);
const { pgcrypto }=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const db=new PGlite({extensions:{pgcrypto}});
const migrationName='20261031234538_expense_seasons_and_installment_prepayments.sql';
const migration=fs.readFileSync(new URL('../supabase/migrations/'+migrationName,import.meta.url),'utf8');
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('000_supabase_stub.sql',import.meta.url),'utf8'));
for(const file of fs.readdirSync(new URL('../v2/sql/',import.meta.url)).filter(f=>/^\d/.test(f)&&!f.startsWith('000')).sort())await db.exec(fs.readFileSync(new URL('../v2/sql/'+file,import.meta.url),'utf8'));
for(const file of fs.readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f!==migrationName).sort())await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
const A='aaaaaaaa-0000-0000-0000-000000000001',B='bbbbbbbb-0000-0000-0000-000000000002';
await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)',[A,'a@example.test',B,'b@example.test']);
async function rpc(actor,name,args={},role='authenticated') {
  await db.exec(`begin; set local role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
    const keys=Object.keys(args),values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
    const result=await db.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,values);
    await db.exec('commit');return result.rows[0].data;
  }catch(e){await db.exec('rollback');throw e;}
}
const a=(await rpc(A,'bootstrap_user')).account.id;
const b=(await rpc(B,'bootstrap_user')).account.id;
const oldB=await rpc(B,'state_get',{p_account:b});
await rpc(B,'state_save',{p_account:b,p_domain:'income',p_version:oldB.versions.income,p_patch:{periods:[{id:'protected-old',year:2027,pay_date:'2027-01-05',window_start:'2027-01-01',window_end:'2027-01-15',calc_mode:'manual',taxable:false,income_net:1000,locked:true}]}});
const familyB=(await rpc(B,'family_command',{p_action:'create',p_family:null,p_payload:{title:'Старая семья'},p_version:null,p_request:crypto.randomUUID()})).family_id;
await db.query("insert into public.family_contributions(family_id,member_id,source_account_id,period_id,pay_date,amount,current_amount,status) select family_id,id,$1,'protected-old','2027-01-05',100,100,'posted' from public.family_members where family_id=$2 limit 1",[b,familyB]);
let old=await rpc(A,'state_get',{p_account:a});
await rpc(A,'state_save',{p_account:a,p_domain:'income',p_version:old.versions.income,p_patch:{periods:[{id:'old',year:2027,pay_date:'2027-01-05',window_start:'2027-01-01',window_end:'2027-01-15',calc_mode:'manual',taxable:false,income_net:1000,locked:true}]}});
old=await rpc(A,'state_get',{p_account:a});
await rpc(A,'state_save',{p_account:a,p_domain:'debts',p_version:old.versions.debts,p_patch:{installments:[{id:'i',title:'Покупка',total:1000}],installment_payments:[{id:'i-1',installment_id:'i',pay_date:'2027-01-20',amount:1000}]}});

test('новая миграция: старые зафиксированные платежи сохраняются, повторный запуск безопасен',async()=>{
  await db.exec(migration);
  const state=await rpc(A,'state_get',{p_account:a});
  assert.deepEqual(state.income.periods[0].installment_snapshot,[{payment_id:'i-1',installment_id:'i',date:'2027-01-20',amount:1000,early:false}]);
  await db.exec(migration);
  assert.deepEqual((await rpc(A,'state_get',{p_account:a})).income.periods[0].installment_snapshot,state.income.periods[0].installment_snapshot);
  assert.deepEqual((await rpc(B,'state_get',{p_account:b})).income.periods[0].installment_snapshot,[]);
  await assert.rejects(db.query("update public.periods set income_net=income_net+1 where account_id=$1",[b]),/защищены/);
  assert.equal((await db.query("select tgenabled from pg_trigger where tgname='protect_family_period' and tgrelid='public.periods'::regclass")).rows[0].tgenabled,'O');
});

test('сезоны SQL: сохранение, реальная дата, пересечение через Новый год и атомарный отказ',async()=>{
  let state=await rpc(A,'state_get',{p_account:a});
  const category={id:'life',title:'Жизнь',mode:'fixed_month',monthly_amount:2000,amount_seasons:[{from:'12-01',to:'03-20',amount:5000},{from:'03-21',to:'11-30',amount:3000}]};
  await rpc(A,'state_save',{p_account:a,p_domain:'expenses',p_version:state.versions.expenses,p_patch:{expense_categories:[category]}});
  state=await rpc(A,'state_get',{p_account:a});
  assert.deepEqual(state.expenses.expense_categories[0].amount_seasons,category.amount_seasons);
  for(const seasons of [[{from:'11-31',to:'12-31',amount:100}], [{from:'12-01',to:'03-20',amount:100},{from:'03-20',to:'04-01',amount:200}], [{from:'01-01',to:'12-31',amount:-1}]]) {
    await assert.rejects(rpc(A,'state_save',{p_account:a,p_domain:'expenses',p_version:state.versions.expenses,p_patch:{expense_categories:[{...category,amount_seasons:seasons}]}}),/constraint/);
    assert.deepEqual((await rpc(A,'state_get',{p_account:a})).expenses.expense_categories[0].amount_seasons,category.amount_seasons);
  }
  await assert.rejects(rpc(B,'state_save',{p_account:a,p_domain:'expenses',p_version:state.versions.expenses,p_patch:{expense_categories:[category]}}),/прав|доступ|member/i);
});

test('рассрочки SQL: снимок проходит generic API и сохраняет погашение после загрузки и смены правила',async()=>{
  let state=await rpc(A,'state_get',{p_account:a});
  await rpc(A,'state_save',{p_account:a,p_domain:'expenses',p_version:state.versions.expenses,p_patch:{expense_categories:[]}});
  state=await rpc(A,'state_get',{p_account:a});
  await rpc(A,'state_save',{p_account:a,p_domain:'income',p_version:state.versions.income,p_patch:{periods:[['p1','2027-03-05',1500],['p2','2027-04-05',1000]].map(([id,date,amount])=>({id,year:2027,pay_date:date,window_start:date,window_end:date,calc_mode:'manual',taxable:false,income_net:amount}))}});
  state=await rpc(A,'state_get',{p_account:a});
  await rpc(A,'state_save',{p_account:a,p_domain:'debts',p_version:state.versions.debts,p_patch:{installments:[{id:'i',title:'Покупка',total:2000}],installment_payments:[{id:'i-1',installment_id:'i',pay_date:'2027-03-20',amount:1000},{id:'i-2',installment_id:'i',pay_date:'2027-04-20',amount:1000}]}});
  state=await rpc(A,'state_get',{p_account:a});
  await rpc(A,'state_save',{p_account:a,p_domain:'settings',p_version:state.versions.settings,p_patch:{allocation_rules:[{stage_code:'installments',priority:3,enabled:true,params:{early_repayment:true}}]}});
  state=await rpc(A,'state_get',{p_account:a});
  const sim=simulate(state,createConfig(state));
  assert.deepEqual(sim.rows.map(r=>r.installmentsTotal),[1500,500]);
  const frozen=freezePeriods(state,sim,['p1']);
  await rpc(A,'state_save',{p_account:a,p_domain:'income',p_version:state.versions.income,p_patch:{periods:frozen.periods}});
  state=await rpc(A,'state_get',{p_account:a});
  assert.ok(state.income.periods[0].installment_snapshot.some(d=>d.early));
  await rpc(A,'state_save',{p_account:a,p_domain:'settings',p_version:state.versions.settings,p_patch:{allocation_rules:[{stage_code:'installments',priority:3,enabled:true,params:{early_repayment:false}}]}});
  state=await rpc(A,'state_get',{p_account:a});
  assert.deepEqual(simulate(state,createConfig(state)).rows.map(r=>r.installmentsTotal),[1500,500]);
  const invalid={...state.income.periods[0],installment_snapshot:[{payment_id:'x',installment_id:'i',date:'2027-11-31',amount:100,early:true}]};
  await assert.rejects(rpc(A,'state_save',{p_account:a,p_domain:'income',p_version:state.versions.income,p_patch:{periods:[invalid,state.income.periods[1]]}}),/constraint/);
});

test('миграция: RLS не ослаблен, новые функции без SECURITY DEFINER и с фиксированным search_path',async()=>{
  const flags=await db.query("select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('expense_items','expense_categories','periods')");
  assert.ok(flags.rows.every(r=>r.relrowsecurity));
  const funcs=await db.query("select prosecdef,proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='api_private' and p.proname in ('valid_amount_seasons','valid_installment_snapshot')");
  assert.equal(funcs.rows.length,2); assert.ok(funcs.rows.every(r=>!r.prosecdef&&r.proconfig.some(c=>c.startsWith('search_path='))));
});

test('семейный worker: взнос и досрочная рассрочка проводятся атомарно и повторно не списываются',async()=>{
  const now=new Date(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),future=addDays(today,35);
  let state=await rpc(A,'state_get',{p_account:a});
  await rpc(A,'state_save',{p_account:a,p_domain:'income',p_version:state.versions.income,p_patch:{periods:[['j1',today],['j2',future]].map(([id,date])=>({id,year:Number(date.slice(0,4)),pay_date:date,window_start:date,window_end:date,calc_mode:'manual',taxable:false,income_net:1000}))}});
  state=await rpc(A,'state_get',{p_account:a});
  await rpc(A,'state_save',{p_account:a,p_domain:'debts',p_version:state.versions.debts,p_patch:{installments:[{id:'i',title:'Покупка',total:1000}],installment_payments:[{id:'j-1',installment_id:'i',pay_date:addDays(today,1),amount:500},{id:'j-2',installment_id:'i',pay_date:addDays(future,1),amount:500}]}});
  state=await rpc(A,'state_get',{p_account:a});
  await rpc(A,'state_save',{p_account:a,p_domain:'settings',p_version:state.versions.settings,p_patch:{allocation_rules:[{stage_code:'installments',priority:3,enabled:true,params:{early_repayment:true}}]}});
  const created=await rpc(A,'family_command',{p_action:'create',p_family:null,p_payload:{title:'Тестовая семья'},p_version:null,p_request:crypto.randomUUID()});
  const family=await rpc(A,'family_get',{p_family:created.family_id});
  await rpc(A,'family_command',{p_action:'rule',p_family:created.family_id,p_payload:{source_account_id:a,revision:0,rule:{mode:'per_payment',amount:100,effective_from:today}},p_version:family.version,p_request:crypto.randomUUID()});
  const run=()=>runFamilyMember({rpc:(name,args)=>rpc('',name,args,'service_role'),memberId:family.members[0].id,post:true,now});
  await run(); await run();
  state=await rpc(A,'state_get',{p_account:a});
  const sim=simulate(state,createConfig(state));
  assert.equal(sim.byId.get('j1').familyContribution.amount,100);
  assert.equal(sim.byId.get('j1').installmentsTotal,900);
  assert.equal(sim.byId.get('j2').installmentsTotal,100);
  assert.equal((await rpc(A,'family_get',{p_family:created.family_id})).contributions.filter(c=>c.status==='posted').length,1);
  assert.ok(state.income.periods.find(p=>p.id==='j1').installment_snapshot.some(d=>d.early&&d.amount===400));
});

test('процент сохраняется без суммы; серверный семейный прогноз использует процент от выплаты',async()=>{
  const actor='cccccccc-0000-0000-0000-000000000003';
  await db.query('insert into auth.users(id,email) values($1,$2)',[actor,'percent@example.test']);
  let state=await rpc(actor,'bootstrap_user');const account=state.account.id;
  const now=new Date(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),date=addDays(today,2);
  await rpc(actor,'state_save',{p_account:account,p_domain:'income',p_version:state.versions.income,p_patch:{periods:[{id:'pay',year:Number(date.slice(0,4)),pay_date:date,window_start:date,window_end:date,calc_mode:'manual',taxable:false,income_net:10000}]}});
  state=await rpc(actor,'state_get',{p_account:account});
  await rpc(actor,'state_save',{p_account:account,p_domain:'expenses',p_version:state.versions.expenses,p_patch:{expense_categories:[{id:'percent',title:'Категория',mode:'percent_income',percent_value:12.5}]}});
  state=await rpc(actor,'state_get',{p_account:account});
  assert.equal(state.expenses.expense_categories[0].monthly_amount,0);
  assert.equal(simulate(state,createConfig(state)).byId.get('pay').categoriesTotal,1250);
  const created=await rpc(actor,'family_command',{p_action:'create',p_family:null,p_payload:{title:'Процентная семья'},p_version:null,p_request:crypto.randomUUID()});
  let family=await rpc(actor,'family_get',{p_family:created.family_id});
  await rpc(actor,'family_command',{p_action:'rule',p_family:family.id,p_payload:{source_account_id:account,revision:0,rule:{mode:'per_payment',amount:2000,effective_from:today}},p_version:family.version,p_request:crypto.randomUUID()});
  await runFamilyMember({rpc:(name,args)=>rpc('',name,args,'service_role'),memberId:family.members[0].id,post:false,now});
  family=await rpc(actor,'family_get',{p_family:created.family_id});
  const forecast=family.contributions.find(c=>c.period_id==='pay');
  assert.equal(forecast.amount,2000);
  assert.notEqual(forecast.status,'posted');
});

test.after(async()=>{await db.close();});
