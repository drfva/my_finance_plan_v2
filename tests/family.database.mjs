/* Локальная интеграция настоящего SQL: FINANCE_PGLITE_MODULE может указывать
   на установленный отдельно dist/index.js. Удалённые базы не используются. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runFamilyMember } from '../src/core/family-worker.js';
import { createConfig } from '../src/core/config.js';
import { simulate } from '../src/engine/allocation.js';

const modulePath = process.env.FINANCE_PGLITE_MODULE;
const entry = modulePath ? pathToFileURL(modulePath).href : '@electric-sql/pglite';
const { PGlite } = await import(entry);
const { pgcrypto } = await import(modulePath ? new URL('contrib/pgcrypto.js',entry).href : '@electric-sql/pglite/contrib/pgcrypto');
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('./000_supabase_stub.sql',import.meta.url),'utf8'));
for (const file of fs.readdirSync(new URL('../v2/sql/',import.meta.url)).filter(f=>/^\d/.test(f)&&!f.startsWith('000')).sort())
  await db.exec(fs.readFileSync(new URL(`../v2/sql/${file}`,import.meta.url),'utf8'));
const migration = new URL('../supabase/migrations/20261031172114_family_plan.sql',import.meta.url);
await db.exec(fs.readFileSync(migration,'utf8'));
await db.query('insert into auth.users(id,email) values($1,$2),($3,$4),($5,$6)',[A,'a@example.test',B,'b@example.test',C,'c@example.test']);

async function rpc(uid, name, args = {}, role = 'authenticated') {
  await db.exec('begin');
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||'']);
    const keys = Object.keys(args), values = Object.values(args).map(v => v!==null&&typeof v==='object'?JSON.stringify(v):v);
    const result = await db.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,values);
    await db.exec('commit'); return result.rows[0].data;
  } catch(e) { await db.exec('rollback'); throw e; }
}
const command = (uid, action, family, payload, version = null, request = crypto.randomUUID()) =>
  rpc(uid,'family_command',{p_action:action,p_family:family,p_payload:payload,p_version:version,p_request:request});
let personal, family, memberId, secondFamily, bMember, bPersonal;

test('семья SQL: старый личный план, создание семьи, идемпотентность и раздельный контекст', async () => {
  personal = (await rpc(A,'bootstrap_user',{p_title:'Личный А'})).account.id;
  const request = crypto.randomUUID();
  family = (await command(A,'create',null,{title:'Семья'},null,request)).family_id;
  assert.equal((await command(A,'create',null,{title:'Семья'},null,request)).family_id,family);
  const state = await rpc(A,'state_get',{p_account:family});
  assert.equal(state.account.plan_kind,'family');
  assert.equal(state.family.members.length,1);
  memberId = state.family.members[0].id;
  assert.equal(state.family_private.rules.length,0);
  assert.equal((await rpc(A,'state_get',{p_account:personal})).account.title,'Личный А');
  await assert.rejects(command(A,'create',null,{title:'Вторая семья'}),/уже состоите/);
});

test('семья SQL: чужой план и семейные данные закрыты; generic API не меняет семью', async () => {
  await rpc(B,'bootstrap_user',{p_title:'Личный Б'});
  await assert.rejects(rpc(B,'family_get',{p_family:family}),/Нет прав/);
  await assert.rejects(rpc(B,'state_get',{p_account:personal}));
  await assert.rejects(rpc(A,'state_save',{p_domain:'income',p_patch:{periods:[]},p_account:family,p_version:0}),/просмотр/);
  await assert.rejects(rpc(A,'family_worker_members',{}),/permission denied/);
  await db.exec('begin; set local role authenticated');
  try { await assert.rejects(db.query('select * from public.family_contributions'),/permission denied/); }
  finally { await db.exec('rollback'); }
});

test('семья SQL: категории, план и статистика, версии и атомарный аудит', async () => {
  let f = await rpc(A,'family_get',{p_family:family});
  await command(A,'category',family,{id:'food',title:'Еда'},f.version);
  await assert.rejects(command(A,'category',family,{id:'stale',title:'Не сохранить'},f.version),/уже изменился/);
  f = await rpc(A,'family_get',{p_family:family});
  await command(A,'expense',family,{category_id:'food',month:'2026-11',amount:80000},f.version);
  f = await rpc(A,'family_get',{p_family:family});
  await command(A,'fact',family,{category_id:'food',month:'2026-11',amount:75000},f.version);
  f = await rpc(A,'family_get',{p_family:family});
  assert.equal(f.monthly_expenses[0].amount,80000);
  assert.equal(f.expense_facts[0].amount,75000);
  const auditCount = f.audit.length;
  await assert.rejects(command(A,'expense',family,{category_id:'food',month:'2026-11',amount:-1},f.version));
  assert.equal((await rpc(A,'family_get',{p_family:family})).audit.length,auditCount);
  assert.equal(f.audit[0].actor_id,A);
});

test('семья SQL: собственное правило, прогноз без проведения и атомарная фиксация', async () => {
  let source = await rpc(A,'state_get',{p_account:personal});
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await rpc(A,'state_save',{p_domain:'income',p_patch:{periods:[{id:'family-p',year:Number(today.slice(0,4)),pay_date:today,window_start:today.slice(0,7)+'-01',window_end:today,calc_mode:'manual',income_net:100000,taxable:false}]},p_account:personal,p_version:source.versions.income});
  await command(A,'rule',family,{source_account_id:personal,revision:0,rule:{mode:'percent',percent:20,effective_from:today}});
  source = await rpc(A,'state_get',{p_account:personal});
  assert.equal(source.family_private.rules.length,1);
  const serverRpc = (name,args) => rpc(null,name,args,'service_role');
  await runFamilyMember({rpc:serverRpc,memberId,actor:A,post:false});
  let f = await rpc(A,'family_get',{p_family:family});
  assert.equal(f.contributions[0].status,'forecast');
  assert.equal(f.contributions[0].amount,20000);
  assert.equal('available_before' in f.contributions[0],false);
  assert.equal('ledger_after' in f.contributions[0],false);
  assert.equal(f.audit.some(a=>a.object_type==='family_contributions'),false);
  const beforePost=await rpc(A,'state_get',{p_account:personal});
  const pending=(await db.query('select to_jsonb(c) as data from public.family_contributions c where member_id=$1',[memberId])).rows[0].data;
  await rpc(null,'family_worker_commit',{p_member:memberId,p_revision:beforePost.family_private.membership.revision,
    p_versions:beforePost.versions,p_rows:[pending],p_freeze:{},p_post:true},'service_role');
  assert.equal((await rpc(A,'family_get',{p_family:family})).contributions[0].status,'forecast','без одновременной фиксации источника поступление не проводится');
  assert.equal((await rpc(A,'state_get',{p_account:personal})).income.periods[0].locked,false);
  await runFamilyMember({rpc:serverRpc,memberId,post:true});
  f = await rpc(A,'family_get',{p_family:family});
  assert.equal(f.contributions[0].status,'posted');
  assert.equal(f.contributions.length,1);
  await runFamilyMember({rpc:serverRpc,memberId,post:true});
  assert.equal((await rpc(A,'family_get',{p_family:family})).contributions.length,1);
  source = await rpc(A,'state_get',{p_account:personal});
  assert.equal(source.income.periods.find(p=>p.id==='family-p').locked,true);
  await assert.rejects(rpc(A,'state_save',{p_domain:'income',p_patch:{periods:[]},p_account:personal,p_version:source.versions.income}),/защищены/);
});

test('семья SQL: приглашение не открывает доступ; принятие, все владельцы и запрет второй семьи', async () => {
  let f=await rpc(A,'family_get',{p_family:family});
  await command(A,'invite',family,{email:'b@example.test'},f.version);
  await assert.rejects(rpc(B,'family_get',{p_family:family}),/Нет прав/);
  const invite=(await db.query("select o.token from family_api.mail_outbox o join public.family_invitations i on i.id=o.invitation_id where i.family_id=$1 and i.email='b@example.test'",[family])).rows[0];
  await assert.rejects(command(C,'accept',null,{token:invite.token}),/подтверждённой почтой/);
  await command(B,'accept',null,{token:invite.token});
  const b=await rpc(B,'state_get',{p_account:family});
  bMember=b.family.members.find(m=>m.is_self).id;
  assert.equal(b.account.role,'owner');
  assert.equal(b.family.members.every(m=>m.role==='owner'),true);
  assert.equal(b.family_private.rules.length,0);
  assert.equal(b.family_private.overrides.length,0);
  assert.equal(JSON.stringify(b.family).includes('income_net'),false);
  assert.equal(JSON.stringify(b.family).includes('available_before'),false);
  await assert.rejects(rpc(B,'state_get',{p_account:personal}));
  const c=await rpc(C,'bootstrap_user',{p_title:'Личный В'});
  secondFamily=(await command(C,'create',null,{title:'Другая семья'})).family_id;
  f=await rpc(C,'family_get',{p_family:secondFamily});
  await command(C,'invite',secondFamily,{email:'b@example.test'},f.version);
  const second=(await db.query("select o.token from family_api.mail_outbox o join public.family_invitations i on i.id=o.invitation_id where i.family_id=$1 and i.email='b@example.test'",[secondFamily])).rows[0];
  await assert.rejects(command(B,'accept',null,{token:second.token}),/уже состоите/);
  await rpc(C,'add_account_member',{p_account:c.account.id,p_email:'b@example.test',p_role:'viewer'});
  assert.equal((await rpc(B,'state_get',{p_account:c.account.id})).account.role,'viewer','ограничение семьи не меняет обычные доступы');
});

test('семья SQL: чужой никнейм и цвет не меняются; общие расходы другого участника редактируются с аудитом', async () => {
  let f=await rpc(B,'family_get',{p_family:family});
  const a=f.members.find(m=>m.id===memberId);
  await command(B,'profile',family,{id:memberId,nickname:'Борис',color:'orange'});
  f=await rpc(A,'family_get',{p_family:family});
  assert.equal(f.members.find(m=>m.id===memberId).nickname,a.nickname);
  assert.equal(f.members.find(m=>m.id===bMember).nickname,'Борис');
  const before=await rpc(A,'state_get',{p_account:personal});
  await command(B,'expense',family,{category_id:'food',month:'2026-11',amount:81000},f.version);
  f=await rpc(B,'family_get',{p_family:family});
  await command(B,'fact',family,{category_id:'food',month:'2026-11',amount:74000},f.version);
  const after=await rpc(A,'state_get',{p_account:personal});
  assert.deepEqual(after.versions,before.versions);
  f=await rpc(A,'family_get',{p_family:family});
  assert.equal(f.audit[0].actor_id,B);
  assert.equal(f.audit[0].before_data.amount,75000);
  assert.equal(f.audit[0].after_data.amount,74000);
  await command(B,'rename',family,{title:'Общий план'},f.version);
  assert.equal((await rpc(A,'family_get',{p_family:family})).title,'Общий план');
});

test('семья SQL: почта берётся из очереди только сервером; аренда защищает повторную отправку', async () => {
  const f=await rpc(A,'family_get',{p_family:family});
  await command(A,'invite',family,{email:'new@example.test'},f.version);
  await assert.rejects(rpc(A,'family_mail_claim',{p_actor:A}),/permission denied/);
  const letters=await rpc(null,'family_mail_claim',{p_actor:A},'service_role');
  const letter=letters.find(x=>x.email==='new@example.test');
  assert.ok(letter);
  assert.equal((await rpc(null,'family_mail_claim',{p_actor:A},'service_role')).length,0);
  await rpc(null,'family_mail_ack',{p_invitation:letter.id,p_lease:letter.lease,p_error:null},'service_role');
  let now=await rpc(A,'family_get',{p_family:family});
  const invitation=now.invitations.find(i=>i.email==='new@example.test');
  assert.equal(invitation.delivery,'sent');
  assert.equal('token' in invitation,false);
  assert.equal('token_hash' in invitation,false);
  await command(B,'revoke',family,{id:invitation.id},now.version);
  await db.query('insert into auth.users(id,email) values($1,$2)',['dddddddd-0000-0000-0000-000000000004','new@example.test']);
  await assert.rejects(command('dddddddd-0000-0000-0000-000000000004','accept',null,{token:letter.token}),/отозвано/);
});

test('семья SQL: будущий взнос правит только автор; ручная сумма соблюдает потолок, фиксация защищена', async () => {
  let source=await rpc(A,'state_get',{p_account:personal});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date=new Date(today+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1,5);const future=date.toISOString().slice(0,10);
  const periods=[...source.income.periods,{id:'future',year:Number(future.slice(0,4)),pay_date:future,window_start:future.slice(0,7)+'-01',window_end:future,calc_mode:'manual',income_manual:true,income_net:100000,taxable:false}];
  await rpc(A,'state_save',{p_domain:'income',p_patch:{periods},p_account:personal,p_version:source.versions.income});
  await command(A,'rule',family,{source_account_id:personal,revision:source.family_private.membership.revision,
    rule:{mode:'percent',percent:20,cap_per_payment:15000,effective_from:today}});
  await command(A,'override',family,{source_account_id:personal,period_id:'future',amount:50000,revision:0});
  await assert.rejects(command(B,'override',family,{source_account_id:personal,period_id:'future',amount:1,revision:0}),/свои будущие/);
  await assert.rejects(command(A,'override',family,{source_account_id:personal,period_id:'family-p',amount:1,revision:0}),/свои будущие/);
  await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId,actor:A,post:false});
  let f=await rpc(B,'state_get',{p_account:family});
  assert.equal(f.family.contributions.find(c=>c.period_id==='future').amount,15000);
  assert.equal(JSON.stringify(f.family).includes('requested_amount'),false);
  assert.equal(f.family_private.overrides.length,0);
  await assert.rejects(command(A,'override',family,{source_account_id:personal,period_id:'future',amount:12000,revision:0}),/уже изменился/);
  await command(A,'override',family,{source_account_id:personal,period_id:'future',amount:null,revision:1});
  source=await rpc(A,'state_get',{p_account:personal});
  assert.equal(source.family_private.overrides[0].amount,null);
});

test('семья SQL: обычный доступ к источнику сохраняет верный баланс, не раскрывает правило и не позволяет подключить источник дважды', async () => {
  await rpc(A,'add_account_member',{p_account:personal,p_email:'b@example.test',p_role:'viewer'});
  await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId,actor:A,post:false});
  let shared=await rpc(B,'state_get',{p_account:personal});
  assert.equal(shared.family_source_connected,true);
  assert.equal(shared.family_private.rules.length,0);
  assert.equal(shared.family_private.contributions.length,2);
  assert.equal(shared.family_private.contributions.every(c=>c.external),true);
  assert.equal(JSON.stringify(shared.family_private).includes('ledger_after'),false);
  const cfg=createConfig(shared);
  const sim=simulate(shared,cfg,{round:cfg.formatter().round});
  assert.equal(sim.rows.find(r=>r.period.id==='family-p').familyContribution.amount,20000);
  assert.equal(sim.rows.find(r=>r.period.id==='future').familyContribution.posted,false);
  assert.equal((await rpc(null,'family_worker_members',{p_actor:B,p_source:personal},'service_role')).length,0,'просмотр не даёт серверного доступа к источнику');
  await rpc(A,'add_account_member',{p_account:personal,p_email:'b@example.test',p_role:'editor'});
  shared=await rpc(B,'state_get',{p_account:personal});
  await assert.rejects(command(B,'rule',family,{source_account_id:personal,revision:shared.family_private.membership.revision,
    rule:{mode:'percent',percent:10,effective_from:shared.income.periods[0].pay_date}}),/уже используется/);
  assert.deepEqual(await rpc(null,'family_worker_members',{p_actor:B,p_source:personal},'service_role'),[memberId]);
  await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId,actor:B,post:false});
});

test('семья SQL: исключение останавливает прогноз, повторное вступление требует нового приглашения', async () => {
  let f=await rpc(B,'family_get',{p_family:family});
  await command(B,'remove',family,{id:memberId},f.version);
  await assert.rejects(rpc(A,'family_get',{p_family:family}),/Нет прав/);
  assert.equal((await rpc(null,'family_worker_members',{p_actor:A},'service_role')).length,0);
  let source=await rpc(A,'state_get',{p_account:personal});
  assert.equal(source.family_private.membership,null);
  assert.equal(source.family_private.contributions[0].amount,20000);
  f=await rpc(B,'family_get',{p_family:family});
  assert.equal(f.contributions.some(c=>c.status==='forecast'&&c.member_id===memberId),false);
  await command(B,'invite',family,{email:'a@example.test'},f.version);
  const invite=(await db.query("select o.token from family_api.mail_outbox o join public.family_invitations i on i.id=o.invitation_id where i.family_id=$1 and i.email='a@example.test' and i.status='pending'",[family])).rows[0];
  await command(A,'accept',null,{token:invite.token});
  source=await rpc(A,'state_get',{p_account:personal});
  assert.notEqual(source.family_private.membership.id,memberId);
  assert.equal(source.family_private.membership.source_account_id,null);
  assert.equal(source.family_private.rules.length,0);
});

test('семья SQL: выход последнего требует предупреждения, удаление не меняет проведённую личную историю', async () => {
  let f=await rpc(B,'family_get',{p_family:family});
  const left=await command(B,'leave',family,{confirm_delete:false},f.version);
  bPersonal=left.return_account_id;
  assert.equal((await rpc(B,'state_get',{p_account:bPersonal})).accounts.some(a=>a.id===family),false);
  f=await rpc(A,'family_get',{p_family:family});
  await assert.rejects(command(A,'leave',family,{confirm_delete:false},f.version),/последний участник/);
  await command(A,'leave',family,{confirm_delete:true},f.version);
  await assert.rejects(rpc(A,'family_get',{p_family:family}),/Нет прав/);
  const source=await rpc(A,'state_get',{p_account:personal});
  assert.equal(source.accounts.some(a=>a.id===family),false);
  assert.equal(source.family_private.contributions[0].amount,20000);
  assert.equal(source.income.periods.find(p=>p.id==='family-p').income_net,100000);
  const second=(await db.query("select o.token from family_api.mail_outbox o join public.family_invitations i on i.id=o.invitation_id where i.family_id=$1 and i.email='b@example.test'",[secondFamily])).rows[0];
  await command(B,'accept',null,{token:second.token});
  assert.equal((await rpc(B,'state_get',{p_account:bPersonal})).family_connection.id,secondFamily);
});

test('семья SQL: повтор миграции не меняет историю и не возвращает удалённый план', async () => {
  await db.exec(fs.readFileSync(migration,'utf8'));
  assert.equal((await rpc(A,'state_get',{p_account:personal})).family_private.contributions[0].amount,20000);
  await assert.rejects(rpc(A,'family_get',{p_family:family}),/Нет прав/);
});

test('семья SQL: общий установщик разворачивает чистую базу без включения взносов в обычном плане', async () => {
  const clean=new PGlite({extensions:{pgcrypto}});
  try {
    await clean.exec('create role service_role nologin bypassrls');
    await clean.exec(fs.readFileSync(new URL('./000_supabase_stub.sql',import.meta.url),'utf8'));
    await clean.exec(fs.readFileSync(new URL('../v2/install.sql',import.meta.url),'utf8'));
    assert.equal((await clean.query("select count(*)::int as n from information_schema.tables where table_name='family_members'")).rows[0].n,1);
    await clean.query('insert into auth.users(id,email) values($1,$2)',[A,'a@example.test']);
    await clean.exec('begin; set local role authenticated');
    await clean.query("select set_config('request.jwt.claim.sub',$1,true)",[A]);
    const state=(await clean.query("select public.bootstrap_user('Чистая установка') as state")).rows[0].state;
    assert.equal(state.account.plan_kind,'personal');
    assert.equal(state.family_source_connected,false);
    assert.equal(state.settings.allocation_rules.some(r=>r.stage_code==='family'),false);
    await clean.exec('commit');
  } finally {await clean.close();}
});

test('семья Cron: настройка проверяет Vault и отправляет все источники пакетами по 10, включая очередь приглашений', async () => {
  const cron=new PGlite();
  try {
    await cron.exec(`create schema vault; create schema cron; create schema net; create schema family_api;
      create table vault.decrypted_secrets(name text,decrypted_secret text);
      create table cron.job(jobid int generated always as identity,jobname text,schedule text,command text);
      create function cron.unschedule(int) returns boolean language sql as $$delete from cron.job where jobid=$1 returning true$$;
      create function cron.schedule(text,text,text) returns int language sql as $$insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid$$;
      create table public.family_members(id uuid, family_id uuid, user_id uuid,source_account_id uuid,active boolean);
      create table public.families(id uuid,deleted_at timestamptz);
      create table public.family_contribution_rules(member_id uuid);
      create table public.family_invitations(id uuid,status text,expires_at timestamptz);
      create table family_api.mail_outbox(invitation_id uuid,state text,retry_at timestamptz,lease_until timestamptz);
      create table net.calls(body jsonb);
      create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$insert into net.calls(body) values($3) returning 1::bigint$$;`);
    const script=fs.readFileSync(new URL('../tools/configure-family-cron.sql',import.meta.url),'utf8').replace(/^create extension.*;$/gm,'');
    await assert.rejects(cron.exec(script),/Добавьте в Vault/);await cron.exec('rollback');
    await cron.exec(`insert into vault.decrypted_secrets values('finance_family_worker_url','https://db.test/functions/v1/family-worker'),('finance_family_cron_secret',repeat('s',32));
      insert into public.families values('ffffffff-0000-0000-0000-000000000001',null);
      insert into public.family_members select ('aaaaaaaa-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'ffffffff-0000-0000-0000-000000000001',gen_random_uuid(),gen_random_uuid(),true from generate_series(1,21) i;
      insert into public.family_contribution_rules select id from public.family_members;
      insert into public.family_invitations values('eeeeeeee-0000-0000-0000-000000000001','pending',now()+interval '1 day');
      insert into family_api.mail_outbox values('eeeeeeee-0000-0000-0000-000000000001','queued',now(),null);`);
    await cron.exec(script);await cron.exec(script);
    const jobs=(await cron.query('select * from cron.job')).rows;
    assert.equal(jobs.length,1);assert.equal(jobs[0].schedule,'0 * * * *');
    await cron.exec(jobs[0].command);
    const sizes=(await cron.query('select jsonb_array_length(body->\'member_ids\') as n from net.calls order by n')).rows.map(x=>x.n);
    assert.deepEqual(sizes,[0,1,10,10]);
  } finally {await cron.close();}
});

test.after(async()=>{await db.close();});
