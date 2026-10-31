import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runFamilyMember } from '../src/core/family-worker.js';
import { createConfig } from '../src/core/config.js';
import { simulate } from '../src/engine/allocation.js';

const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const { PGlite }=await import(entry);
const { pgcrypto }=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('./000_supabase_stub.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../v2/install.sql',import.meta.url),'utf8'));
const A='aaaaaaaa-0000-0000-0000-000000000001',B='bbbbbbbb-0000-0000-0000-000000000002',C='cccccccc-0000-0000-0000-000000000003',D='dddddddd-0000-0000-0000-000000000004';
await db.query('insert into auth.users(id,email) values($1,$2),($3,$4),($5,$6),($7,$8)',[A,'erase-me@example.test',B,'b@example.test',C,'last@example.test',D,'d@example.test']);
async function rpc(uid,name,args={},role='authenticated'){
  await db.exec('begin');try{
    await db.exec(`set local role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid??'']);
    const keys=Object.keys(args),values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
    const r=await db.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,values);
    await db.exec('commit');return r.rows[0].data;
  }catch(e){await db.exec('rollback');throw e;}
}
const cmd=(uid,action,family,payload,version=null)=>rpc(uid,'family_command',{p_action:action,p_family:family,p_payload:payload,p_version:version,p_request:crypto.randomUUID()});
const remove=(uid,preview,confirmation='УДАЛИТЬ')=>rpc(uid,'delete_my_account',{p_confirmation:confirmation,p_version:preview.version});
let personal,shared,family,member;
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function source(uid,account,family){
  const s=await rpc(uid,'state_get',{p_account:account});
  const dates=[today,`${Number(today.slice(0,4))+1}-01-15`];
  await rpc(uid,'state_save',{p_domain:'income',p_patch:{periods:dates.map((date,i)=>({id:`p${i}`,year:Number(date.slice(0,4)),pay_date:date,window_start:date.slice(0,7)+'-01',window_end:date,calc_mode:'manual',income_net:100000,taxable:false}))},p_account:account,p_version:s.versions.income});
  await cmd(uid,'rule',family,{source_account_id:account,revision:0,rule:{mode:'percent',percent:20,effective_from:today}});
  const state=await rpc(uid,'state_get',{p_account:account});
  const id=state.family_private.membership.id;
  await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId:id,post:true});return id;
}

test('удаление SQL: подготавливаем личные и общие данные, семейную историю и прогноз',async()=>{
  personal=(await rpc(A,'bootstrap_user',{p_title:'Удалить личный'})).account.id;
  shared=await rpc(A,'create_account',{p_title:'Сохранить общий'});
  await rpc(B,'bootstrap_user');await rpc(C,'bootstrap_user');await rpc(D,'bootstrap_user');
  await rpc(A,'add_account_member',{p_account:shared,p_email:'b@example.test',p_role:'viewer'});
  family=(await cmd(A,'create',null,{title:'Общая семья'})).family_id;
  await db.query("insert into public.account_members(account_id,user_id,role) values($1,$2,'owner')",[family,B]);
  await db.query("insert into public.family_members(family_id,user_id,email,nickname) values($1,$2,'b@example.test','Борис')",[family,B]);
  await cmd(A,'profile',family,{nickname:'Private nickname',color:'purple'});
  member=await source(A,personal,family);
  await db.query("insert into public.expense_categories(account_id,id,title) values($1,'food','Еда')",[shared]);
  await db.query("insert into public.expense_facts(account_id,category_id,ym,amount,entered_by) values($1,'food','2026-10',100,$2)",[shared,A]);
  await db.query("insert into public.user_settings(user_id,key,value) values($1,'locale','\"ru\"')",[A]);
  const p=await rpc(A,'account_deletion_preview');
  assert.equal(p.plans.find(x=>x.id===personal).delete,true);
  assert.equal(p.plans.find(x=>x.id===shared).blocked,true);
  assert.equal(p.family.last_member,false);
  assert.equal((await db.query('select count(*)::int n from public.family_contributions where member_id=$1',[member])).rows[0].n,2);
});

test('удаление SQL: подтверждение, права и блокировка единственного владельца защищают данные',async()=>{
  const p=await rpc(A,'account_deletion_preview');
  await assert.rejects(remove(A,p,'да'),/УДАЛИТЬ/);
  await assert.rejects(remove(A,p),/другого владельца/);
  await assert.rejects(rpc(B,'account_assign_owner',{p_account:shared,p_user:B}),/только владелец/);
  await assert.rejects(rpc(A,'account_assign_owner',{p_account:shared,p_user:C}),/существующего участника/);
  await assert.rejects(rpc(A,'account_assign_owner',{p_account:family,p_user:B}),/личного плана/);
  await assert.rejects(rpc(null,'account_deletion_preview'),/Нужно войти/);
  await assert.rejects(rpc(null,'delete_my_account',{p_confirmation:'УДАЛИТЬ',p_version:p.version},'anon'),/permission denied/);
  assert.ok((await db.query('select id from auth.users where id=$1',[A])).rows.length);
  assert.equal((await rpc(A,'state_get',{p_account:personal})).family_private.membership.active,true);
});

test('удаление SQL: назначение владельца и изменения состава требуют нового просмотра условий',async()=>{
  const old=await rpc(A,'account_deletion_preview');
  await rpc(A,'account_assign_owner',{p_account:shared,p_user:B});
  await assert.rejects(remove(A,old),/Состав планов изменился/);
  const p=await rpc(A,'account_deletion_preview');assert.equal(p.plans.find(x=>x.id===shared).blocked,false);
  await rpc(A,'add_account_member',{p_account:personal,p_email:'d@example.test',p_role:'viewer'});
  await assert.rejects(remove(A,p),/Состав планов изменился/);
  assert.equal((await rpc(A,'account_deletion_preview')).plans.find(x=>x.id===personal).blocked,true);
  await db.query('delete from public.account_members where account_id=$1 and user_id=$2',[personal,D]);
});

test('удаление SQL: поздняя ошибка удаления Auth откатывает очистку данных и обезличивание',async()=>{
  await db.exec('create table public.deletion_test_hold(user_id uuid references auth.users(id))');
  await db.query('insert into public.deletion_test_hold values($1)',[A]);
  try {
    const p=await rpc(A,'account_deletion_preview');
    await assert.rejects(remove(A,p),/foreign key constraint/);
    assert.equal((await rpc(A,'state_get',{p_account:personal})).family_private.membership.active,true);
    const f=await rpc(A,'family_get',{p_family:family});
    assert.equal(f.members.find(m=>m.id===member).nickname,'Private nickname');
    assert.equal(f.contributions.length,2);
  }finally{await db.exec('drop table public.deletion_test_hold');}
});

test('удаление SQL: личные данные и Auth удаляются, общие планы и проведённые взносы остаются обезличенными',async()=>{
  const p=await rpc(A,'account_deletion_preview');assert.deepEqual(await remove(A,p),{deleted:true});
  assert.equal((await db.query('select count(*)::int n from auth.users where id=$1',[A])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.accounts where id=$1',[personal])).rows[0].n,0);
  assert.equal((await db.query('select created_by from public.accounts where id=$1',[shared])).rows[0].created_by,null);
  assert.equal((await db.query('select entered_by from public.expense_facts where account_id=$1',[shared])).rows[0].entered_by,null);
  assert.equal((await db.query('select count(*)::int n from public.user_settings where user_id=$1',[A])).rows[0].n,0);
  const f=await rpc(B,'family_get',{p_family:family});
  assert.equal(f.contributions.length,1);assert.equal(f.contributions[0].amount,20000);
  const person=f.members.find(x=>x.id===member);assert.equal(person.active,false);assert.equal(person.nickname,'Удалённый участник');assert.equal(person.email,'');
  const journal=(await db.query('select * from public.family_contributions where member_id=$1',[member])).rows[0];
  assert.equal(journal.source_account_id,null);assert.deepEqual(journal.ledger_after,{});
  const audit=JSON.stringify((await db.query('select * from public.family_audit where family_id=$1',[family])).rows);
  assert.equal(audit.includes('erase-me@example.test'),false);assert.equal(audit.includes('Private nickname'),false);
  assert.equal((await db.query('select count(*)::int n from public.family_contribution_rules where member_id=$1',[member])).rows[0].n,0);
  await assert.rejects(rpc(A,'account_deletion_preview'),/действующий аккаунт/);
  await assert.rejects(rpc(A,'create_account',{p_title:'Устаревший JWT'}),/foreign key constraint/);
  assert.equal((await rpc(B,'state_get',{p_account:shared})).account.role,'owner');
});

test('удаление SQL: последний участник удаляет семью; общий личный источник сохраняет вычет исторического взноса',async()=>{
  const personalC=(await rpc(C,'bootstrap_user')).account.id;
  await rpc(C,'add_account_member',{p_account:personalC,p_email:'d@example.test',p_role:'owner'});
  const familyC=(await cmd(C,'create',null,{title:'Последняя семья'})).family_id;
  const memberC=await source(C,personalC,familyC);
  const p=await rpc(C,'account_deletion_preview');assert.equal(p.family.last_member,true);
  assert.equal(p.plans.find(x=>x.id===personalC).delete,false);
  await remove(C,p);
  assert.ok((await db.query('select deleted_at from public.families where id=$1',[familyC])).rows[0].deleted_at);
  const state=await rpc(D,'state_get',{p_account:personalC}),cfg=createConfig(state);
  assert.equal(state.family_private.contributions[0].amount,20000);
  assert.equal(simulate(state,cfg).byId.get('p0').familyContribution.amount,20000);
  assert.equal((await db.query('select source_account_id from public.family_contributions where member_id=$1',[memberC])).rows[0].source_account_id,personalC);
});

test('удаление SQL: повтор миграции сохраняет историю и не выдаёт доступ к внутренним функциям',async()=>{
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261031204207_voluntary_account_deletion.sql',import.meta.url),'utf8'));
  assert.equal((await rpc(B,'family_get',{p_family:family})).contributions[0].amount,20000);
  await assert.rejects(rpc(B,'account_deletion_preview',{p_user:A}),/function.*does not exist/);
});
test.after(async()=>{await db.close();});
