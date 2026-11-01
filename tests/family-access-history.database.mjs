import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {runFamilyMember} from '../src/core/family-worker.js';
import {familyToday} from '../src/engine/family.js';
import {addDays} from '../src/engine/dates.js';
const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const {PGlite}=await import(entry),{pgcrypto}=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('000_supabase_stub.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../v2/install.sql',import.meta.url),'utf8'));
const A='aaaaaaaa-0000-0000-0000-000000000001',B='bbbbbbbb-0000-0000-0000-000000000002',C='cccccccc-0000-0000-0000-000000000003';
await db.query('insert into auth.users(id,email) values($1,$2),($3,$4),($5,$6)',[A,'owner@example.test',B,'invited@example.test',C,'outsider@example.test']);
async function rpc(uid,name,args={},role='authenticated'){
  await db.exec('begin');try{
    await db.exec(`set local role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||'']);
    const keys=Object.keys(args),values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
    const result=await db.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,values);
    await db.exec('commit');return result.rows[0].data;
  }catch(e){await db.exec('rollback');throw e;}
}
const sourceA=(await rpc(A,'bootstrap_user')).account.id,sourceB=(await rpc(B,'bootstrap_user')).account.id;
const family=(await rpc(A,'family_command',{p_action:'create',p_family:null,p_payload:{title:'Общая семья'},p_version:null,p_request:crypto.randomUUID()})).family_id;
const get=uid=>rpc(uid,'family_get',{p_family:family});
async function cmd(uid,action,payload){const f=await get(uid);return rpc(uid,'family_command',{p_action:action,p_family:family,p_payload:payload,p_version:f.version,p_request:crypto.randomUUID()});}
await cmd(A,'invite',{email:'invited@example.test'});
const token=(await db.query('select token from family_api.mail_outbox order by invitation_id limit 1')).rows[0].token;
await rpc(B,'family_command',{p_action:'accept',p_family:null,p_payload:{token},p_version:null,p_request:crypto.randomUUID()});
const today=familyToday(),future=addDays(today,2),members=(await get(A)).members;
const memberA=members.find(m=>m.is_self).id,memberB=members.find(m=>!m.is_self).id;
for(const [uid,source,amount] of [[A,sourceA,10000],[B,sourceB,15000]]){
  const state=await rpc(uid,'state_get',{p_account:source});
  await rpc(uid,'state_save',{p_account:source,p_domain:'income',p_version:state.versions.income,p_patch:{periods:[
    {id:'p1',year:Number(future.slice(0,4)),pay_date:future,window_start:future,window_end:future,calc_mode:'manual',taxable:false,income_net:50000},
    {id:'p2',year:Number(future.slice(0,4)),pay_date:addDays(future,1),window_start:future,window_end:future,calc_mode:'manual',taxable:false,income_net:0},
  ]}});
  await cmd(uid,'rule',{source_account_id:source,revision:0,rule:{mode:'per_payment',amount,effective_from:today}});
}
for(const memberId of [memberA,memberB])await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId,post:false});
await cmd(A,'category',{id:'living',title:'Общие расходы',mode:'fixed_month',monthly_amount:1000});

test('семья: приглашённый видит те же взносы и распределения, включая нулевые прогнозы',async()=>{
  const owner=await get(A),invited=await get(B);
  assert.deepEqual(invited.contributions,owner.contributions);
  assert.equal(invited.contributions.length,4);
  assert.equal(invited.contributions.filter(c=>c.amount===0).length,2);
  assert.deepEqual(invited.budget.rows,owner.budget.rows);
  assert.equal(invited.members.find(m=>m.is_self).id,memberB);
  assert.doesNotMatch(JSON.stringify(invited.budget),/income_net|salary_rates|available_before|source_account_id|ledger_after/);
});

test('семья: сумму и распределение будущего взноса изменяет только его автор',async()=>{
  await assert.rejects(cmd(B,'allocation',{member_id:memberA,period_id:'p1',category_id:'living',amount:99}),/только распределение своих/);
  await assert.rejects(cmd(A,'allocation',{member_id:memberB,period_id:'p1',category_id:'living',amount:99}),/только распределение своих/);
  await assert.rejects(cmd(B,'reset_allocations',{member_id:memberA,period_id:'p1'}),/только распределение своих/);
  await cmd(B,'allocation',{member_id:memberB,period_id:'p1',category_id:'living',amount:700});
  let f=await get(A);
  assert.equal(f.budget.rows.find(r=>r.member_id===memberB&&r.period_id==='p1').allocations.find(a=>a.category_id==='living').amount,700);
  await cmd(B,'reset_allocations',{member_id:memberB,period_id:'p1'});
  f=await get(B);assert.ok(f.budget.rows.find(r=>r.member_id===memberB&&r.period_id==='p1').allocations.every(a=>!a.manual));
  await assert.rejects(cmd(B,'override',{source_account_id:sourceA,period_id:'p1',amount:1,revision:0}),/Только свой|сво|источник/);
});

let first;
test('история: по 10 записей, прошедший месяц скрывается и физически удаляется',async()=>{
  await db.query("insert into public.family_audit(family_id,actor_name,actor_kind,action,object_type,object_id,created_at) select $1,'Тест','system','UPDATE','family_categories','log-'||g,now()-g*interval '1 minute' from generate_series(1,27) g",[family]);
  await db.query("insert into public.family_audit(family_id,actor_name,actor_kind,action,object_type,object_id,created_at) values($1,'Тест','system','UPDATE','family_categories','expired',now()-interval '40 days')",[family]);
  const raw=await get(B);assert.equal(raw.audit.length,10);assert.ok(raw.audit_pages>=3);
  assert.ok(raw.audit.every(a=>a.object_id!=='expired'));
  await assert.rejects(rpc(C,'family_history_page',{p_family:family,p_page:1,p_anchor:null}),/Нет прав/);
  assert.equal((await db.query("select count(*)::int n from public.family_audit where family_id=$1 and object_id='expired'",[family])).rows[0].n,1,'чужой пользователь не запускает очистку семьи');
  first=await rpc(B,'family_history_page',{p_family:family,p_page:1,p_anchor:null});
  assert.equal(first.items.length,10);assert.equal(first.page,1);
  assert.equal((await db.query("select count(*)::int n from public.family_audit where family_id=$1 and object_id='expired'",[family])).rows[0].n,0);
});

test('история: новые события не сдвигают открытые страницы, обновление показывает новые',async()=>{
  await cmd(A,'category',{id:'living',title:'Обновлённые расходы'});
  const second=await rpc(B,'family_history_page',{p_family:family,p_page:2,p_anchor:first.anchor});
  assert.equal(second.items.length,10);assert.equal(second.total,first.total);
  assert.ok(second.items.every(a=>a.id<first.items.at(-1).id));
  const sameFirst=await rpc(A,'family_history_page',{p_family:family,p_page:1,p_anchor:first.anchor});
  assert.deepEqual(sameFirst.items,first.items);
  const refreshed=await rpc(B,'family_history_page',{p_family:family,p_page:1,p_anchor:null});
  assert.ok(refreshed.anchor>first.anchor);
  const last=await rpc(B,'family_history_page',{p_family:family,p_page:99999,p_anchor:refreshed.anchor});
  assert.equal(last.page,last.pages);assert.ok(last.items.length>0&&last.items.length<=10);
});

test('история: серверная задача чистит старые записи без открытия приложения; внутренние функции закрыты',async()=>{
  await db.query("insert into public.family_audit(family_id,actor_name,actor_kind,action,object_type,object_id,created_at) values($1,'Тест','system','UPDATE','family_categories','expired-worker',now()-interval '40 days')",[family]);
  await rpc(null,'family_mail_claim',{p_actor:null},'service_role');
  assert.equal((await db.query("select count(*)::int n from public.family_audit where object_id='expired-worker'")).rows[0].n,0);
  await db.exec('begin;set local role authenticated');
  await assert.rejects(db.query('select family_api.prune_audit()'),/permission denied/);await db.exec('rollback');
  const migration=fs.readFileSync(new URL('../supabase/migrations/20261101190301_family_history_and_access.sql',import.meta.url),'utf8');
  await db.exec(migration);
  assert.deepEqual((await get(A)).contributions,(await get(B)).contributions);
});

test('история: миграция обновляет существующую базу при вставке SQL с переносами Windows',async()=>{
  const upgrade=new PGlite({extensions:{pgcrypto}});
  const windowsSQL=s=>s.replace(/\r?\n/g,'\r\n');
  try{
    await upgrade.exec('create role service_role nologin bypassrls');
    await upgrade.exec(fs.readFileSync(new URL('000_supabase_stub.sql',import.meta.url),'utf8'));
    for(const name of fs.readdirSync(new URL('../v2/sql/',import.meta.url)).filter(n=>/^\d/.test(n)&&!n.startsWith('000')).sort()){
      await upgrade.exec(windowsSQL(fs.readFileSync(new URL('../v2/sql/'+name,import.meta.url),'utf8')));
    }
    const filename='20261101190301_family_history_and_access.sql';
    for(const name of fs.readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n<filename).sort()){
      await upgrade.exec(windowsSQL(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')));
    }
    const migration=windowsSQL(fs.readFileSync(new URL('../supabase/migrations/'+filename,import.meta.url),'utf8'));
    await upgrade.exec(migration);
    await upgrade.exec(migration);
    const definitions=(await upgrade.query(`select pg_get_functiondef('family_api.read(uuid)'::regprocedure) as reader,
      pg_get_functiondef('family_api.command(text,uuid,jsonb,bigint,uuid)'::regprocedure) as command,
      pg_get_functiondef('family_api.mail_claim(uuid)'::regprocedure) as worker`)).rows[0];
    assert.match(definitions.reader,/family_api.history_data\(p_family,1,null\)/);
    assert.doesNotMatch(definitions.reader,/limit 200|c\.amount > 0/);
    assert.equal((definitions.reader.match(/family-history-access-v3/g)||[]).length,1);
    assert.match(definitions.command,/contribution\.member_id<>m\.id/);
    assert.match(definitions.worker,/family_api\.prune_audit\(\)/);
  }finally{await upgrade.close();}
});
test.after(async()=>{await db.close();});
