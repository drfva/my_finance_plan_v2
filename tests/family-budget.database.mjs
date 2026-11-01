import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {addDays,addMonths} from '../src/engine/dates.js';
import {familyToday,familyYearBudget} from '../src/engine/family.js';
const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const {PGlite}=await import(entry),{pgcrypto}=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role service_role nologin bypassrls');
await db.exec(fs.readFileSync(new URL('000_supabase_stub.sql',import.meta.url),'utf8'));
for(const name of fs.readdirSync(new URL('../v2/sql/',import.meta.url)).filter(n=>/^\d/.test(n)&&!n.startsWith('000')).sort())await db.exec(fs.readFileSync(new URL('../v2/sql/'+name,import.meta.url),'utf8'));
const filename='20261101130135_family_monthly_budget.sql',migration=fs.readFileSync(new URL('../supabase/migrations/'+filename,import.meta.url),'utf8');
for(const name of fs.readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n<filename).sort())await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
const A='aaaaaaaa-0000-0000-0000-000000000001',B='bbbbbbbb-0000-0000-0000-000000000002',C='cccccccc-0000-0000-0000-000000000003';
await db.query('insert into auth.users(id,email) values($1,$2),($3,$4),($5,$6)',[A,'anna@example.test',B,'sasha@example.test',C,'other@example.test']);
async function rpc(uid,name,args={},role='authenticated'){
  await db.exec('begin');try{
    await db.exec(`set local role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||'']);
    const keys=Object.keys(args),values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
    const result=await db.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,values);
    await db.exec('commit');return result.rows[0].data;
  }catch(e){await db.exec('rollback');throw e;}
}
const personalA=(await rpc(A,'bootstrap_user')).account.id,personalB=(await rpc(B,'bootstrap_user')).account.id;
const family=(await rpc(A,'family_command',{p_action:'create',p_family:null,p_payload:{title:'Бюджет семьи'},p_version:null,p_request:crypto.randomUUID()})).family_id;
await db.query("insert into public.account_members(account_id,user_id,role) values($1,$2,'owner')",[family,B]);
await db.query("insert into public.family_members(family_id,user_id,email,nickname,color,source_account_id) values($1,$2,'sasha@example.test','Саша','green',$3)",[family,B,personalB]);
await db.query('update public.family_members set source_account_id=$1 where family_id=$2 and user_id=$3',[personalA,family,A]);
const members=(await rpc(A,'family_get',{p_family:family})).members,memberA=members.find(m=>m.is_self).id,memberB=members.find(m=>!m.is_self).id;
const today=familyToday(),month=today.slice(0,7),year=Number(today.slice(0,4));
// Future dates stay inside this month even when the test runs at its end.
const future=month+'-'+String(new Date(Date.UTC(year,Number(today.slice(5,7)),0)).getUTCDate()).padStart(2,'0');
const previous=addMonths(year,Number(today.slice(5,7)),-1),pastMonth=`${previous.y}-${String(previous.m).padStart(2,'0')}`;
async function get(){return rpc(A,'family_get',{p_family:family});}
async function cmd(action,payload,actor=A,version,request=crypto.randomUUID()){
  const f=await get();return rpc(actor,'family_command',{p_action:action,p_family:family,p_payload:payload,p_version:version??f.version,p_request:request});
}
await cmd('category',{id:'food',title:'Еда'});
await cmd('expense',{category_id:'food',month,amount:1000});
await cmd('expense',{category_id:'food',month:pastMonth,amount:700});
await cmd('fact',{category_id:'food',month:pastMonth,amount:500});
for(const [period,member,source,date,amount,status] of [
  ['past',memberA,personalA,pastMonth+'-15',3000,'posted'],['p1',memberA,personalA,today,10000,'posted'],
  ['p2',memberA,personalA,future,30000,'forecast'],['p3',memberB,personalB,future,60000,'forecast'],
])await db.query('insert into public.family_contributions(family_id,member_id,source_account_id,period_id,pay_date,amount,current_amount,status) values($1,$2,$3,$4,$5,$6,$6,$7)',[family,member,source,period,date,amount,status]);
const row=(f,id)=>f.budget.rows.find(r=>r.period_id===id),monthly=f=>f.budget.months.find(m=>m.month===month);
// A separate legacy family: the parent never had its own monthly amount.
const personalC=(await rpc(C,'bootstrap_user')).account.id;
const oldFamily=(await rpc(C,'family_command',{p_action:'create',p_family:null,p_payload:{title:'Старые подкатегории'},p_version:null,p_request:crypto.randomUUID()})).family_id;
async function oldCommand(action,payload){const f=await rpc(C,'family_get',{p_family:oldFamily});return rpc(C,'family_command',{p_action:action,p_family:oldFamily,p_payload:payload,p_version:f.version,p_request:crypto.randomUUID()});}
await oldCommand('category',{id:'parent',title:'Старый родитель'});
await oldCommand('category',{id:'child',parent_id:'parent',title:'Старая подкатегория'});
await oldCommand('expense',{category_id:'child',month:pastMonth,amount:100});
const oldMember=(await rpc(C,'family_get',{p_family:oldFamily})).members[0].id;
await db.query("insert into public.family_contributions(family_id,member_id,source_account_id,period_id,pay_date,amount,current_amount,status) values($1,$2,$3,'old-child',$4,1000,1000,'posted')",[oldFamily,oldMember,personalC,pastMonth+'-15']);
let fixed;

test('семейный бюджет: миграция закрепляет прошлое и сохраняет старые месячные планы',async()=>{
  await db.exec(migration);
  let f=await get();fixed=structuredClone(row(f,'p1'));
  assert.equal(f.categories[0].monthly_amount,1000);
  assert.deepEqual(['p1','p2','p3'].map(id=>row(f,id).expenses),[100,300,600]);
  assert.equal(row(f,'p1').locked,true);
  assert.equal(f.budget.months.find(m=>m.month===pastMonth).planned,700);
  await db.exec(migration);
  f=await get();assert.deepEqual(row(f,'p1'),fixed,'повторная миграция не переписывает фиксацию');
  const old=await rpc(C,'family_get',{p_family:oldFamily});
  assert.equal(old.budget.rows[0].expenses,100,'старая история подкатегории закрепляется даже без собственной суммы родителя');
});

test('семейный бюджет: меняются только будущие доли фиксированной суммы',async()=>{
  await cmd('category',{id:'food',monthly_amount:2000});
  let f=await get();assert.deepEqual(row(f,'p1'),fixed);
  assert.equal(row(f,'p2').expenses+row(f,'p3').expenses,1900);
  assert.equal(monthly(f).planned,2000);
  await db.query("update public.family_contributions set amount=60000,current_amount=60000 where family_id=$1 and period_id='p2'",[family]);
  f=await get();assert.deepEqual([row(f,'p2').expenses,row(f,'p3').expenses],[950,950]);
  assert.deepEqual(row(f,'p1'),fixed);
});

test('семейный бюджет: процент от всех взносов и подкатегории засчитывают старое распределение',async()=>{
  await cmd('category',{id:'food',mode:'percent_month',percent_value:10});
  let f=await get();assert.equal(monthly(f).planned,13000);
  assert.deepEqual([row(f,'p2').expenses,row(f,'p3').expenses],[6450,6450]);
  await cmd('category',{id:'cafe',title:'Кафе',parent_id:'food',percent_value:5});
  await cmd('category',{id:'cinema',title:'Кино',parent_id:'food',percent_value:7.5});
  f=await get();assert.equal(monthly(f).planned,16250,'12.5 % от 130000, старые 100 не добавляются второй раз');
  assert.equal(row(f,'p2').expenses+row(f,'p3').expenses,16150);
  assert.deepEqual(row(f,'p1'),fixed);
  assert.equal(f.budget.months.find(m=>m.month===pastMonth).planned,700,'шаблон не меняет закрытый месяц');
});

test('семейный бюджет: удаление и добавление будущих взносов пересчитывает месяц',async()=>{
  await db.query("delete from public.family_contributions where family_id=$1 and period_id='p3'",[family]);
  let f=await get();assert.equal(monthly(f).planned,8750);assert.equal(row(f,'p2').expenses,8650);
  await db.query("insert into public.family_contributions(family_id,member_id,source_account_id,period_id,pay_date,amount,current_amount,status) values($1,$2,$3,'p4',$4,20000,20000,'forecast')",[family,memberB,personalB,future]);
  f=await get();assert.equal(monthly(f).planned,11250);assert.equal(row(f,'p2').expenses+row(f,'p4').expenses,11150);
  assert.deepEqual(row(f,'p1'),fixed);
});

test('семейный бюджет: ручные поля, сброс, версии и запрет изменения прошедшей карточки',async()=>{
  if(future<=today)return; // On the last day there are no editable future dates in this month.
  const request=crypto.randomUUID(),payload={member_id:memberA,period_id:'p2',category_id:'cafe',amount:2000};
  const before=await get();await cmd('allocation',payload,B,before.version,request);
  let f=await get();assert.equal(row(f,'p2').allocations.find(a=>a.category_id==='cafe').amount,2000);
  assert.equal(row(f,'p2').allocations.find(a=>a.category_id==='cafe').manual,true);
  const previousId=row(f,'p2').contribution_id;
  await db.query("with old as(delete from public.family_contributions where family_id=$1 and period_id='p2' and status='forecast' returning *) insert into public.family_contributions(family_id,member_id,source_account_id,period_id,pay_date,amount,current_amount,status) select family_id,member_id,source_account_id,period_id,pay_date,amount,current_amount,status from old",[family]);
  f=await get();assert.notEqual(row(f,'p2').contribution_id,previousId);
  assert.equal(row(f,'p2').allocations.find(a=>a.category_id==='cafe').amount,2000,'обновление идентификатора прогноза не стирает ручную сумму');
  await cmd('allocation',payload,B,before.version,request);
  assert.equal((await get()).version,f.version,'повтор запроса идемпотентен');
  await assert.rejects(cmd('allocation',{...payload,amount:1},B,before.version),/уже изменился/);
  await assert.rejects(cmd('allocation',{...payload,period_id:'p1'},A),/зафиксировано/);
  await cmd('reset_allocations',{member_id:memberA,period_id:'p2'});
  f=await get();assert.ok(row(f,'p2').allocations.every(a=>!a.manual));
  assert.deepEqual(row(f,'p1'),fixed);
});

test('семейный бюджет: архив категории сохраняет фиксации и факт, годовые итоги согласованы',async()=>{
  await cmd('delete_category',{id:'food'});
  const f=await get();assert.equal(monthly(f).planned,100);
  assert.equal(row(f,'p2').expenses,0);assert.deepEqual(row(f,'p1'),fixed);
  assert.equal(f.expense_facts.find(e=>e.month===pastMonth).amount,500);
  const b=familyYearBudget(f,year),months=f.budget.months.filter(m=>m.month.startsWith(String(year)));
  assert.equal(b.planned,months.reduce((s,m)=>s+m.planned,0));
  assert.equal(b.expected,f.contributions.filter(c=>c.pay_date.startsWith(String(year))).reduce((s,c)=>s+c.amount,0));
});

test('семейный бюджет: приватность, RLS и неизменяемый серверный снимок',async()=>{
  await assert.rejects(rpc(C,'family_get',{p_family:family}),/Нет прав/);
  for(const table of ['family_allocation_overrides','family_budget_months']){
    assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass',['public.'+table])).rows[0].relrowsecurity,true);
    await db.exec('begin;set local role authenticated');
    await assert.rejects(db.query(`select * from public.${table}`),/permission denied/);await db.exec('rollback');
  }
  await assert.rejects(db.query("update public.family_contributions set allocation_snapshot='[]' where family_id=$1 and period_id='p1'",[family]),/зафиксированы/);
  const f=await get();
  assert.doesNotMatch(JSON.stringify(f.budget),/source_account_id|available_before|ledger_after/);
});

test('семейный бюджет: старая команда месячной суммы работает после миграции даже при нулевом шаблоне',async()=>{
  await cmd('category',{id:'legacy',title:'Старая статья'});
  await cmd('expense',{category_id:'legacy',month,amount:3000});
  const f=await get();
  assert.equal(monthly(f).planned,3100);
  assert.equal(row(f,'p2').allocations.find(a=>a.category_id==='legacy').amount+row(f,'p4').allocations.find(a=>a.category_id==='legacy').amount,3000);
  assert.equal(monthly(f).unassigned,0);
  await cmd('category',{id:'legacy-child',title:'Новая подкатегория',parent_id:'legacy',monthly_amount:1000});
  const withChild=await get();
  assert.equal(monthly(withChild).planned,1100,'новая подкатегория заменяет старую общую месячную сумму, а не добавляется к ней');
});

test('семейный бюджет: фиксированная сумма повторяется в будущих месяцах, включая месяцы без взносов',async()=>{
  await cmd('category',{id:'legacy',monthly_amount:1000});
  await db.query("insert into public.family_contributions(family_id,member_id,source_account_id,period_id,pay_date,amount,current_amount,status) values($1,$2,$3,'next-year',$4,5000,5000,'forecast')",[family,memberB,personalB,`${year+1}-01-15`]);
  const f=await get(),b=familyYearBudget(f,year+1);
  assert.equal(b.planned,12000);assert.equal(b.expected,5000);assert.equal(b.forecastBalance,-7000);
  assert.equal(b.unassigned,11000,'11 месяцев без взносов сохраняют свой план');
  await cmd('category',{id:'legacy',title:'Ежемесячная статья'}); // worker/commands remember the observed plan horizon.
  await db.query("delete from public.family_contributions where family_id=$1 and period_id='next-year'",[family]);
  assert.equal(familyYearBudget(await get(),year+1).planned,12000,'удаление последнего прогноза не удаляет год и фиксированный бюджет');
});

test('семейный бюджет: повтор миграции после правок не восстанавливает удалённую категорию и старый шаблон',async()=>{
  const before=await get();await db.exec(migration);const after=await get();
  assert.equal(after.categories.find(c=>c.id==='food').archived,true);
  assert.equal(after.categories.find(c=>c.id==='legacy').monthly_amount,1000);
  assert.deepEqual(after.budget,before.budget);
});

test('семейный бюджет: сезон через Новый год, проверка периода и атомарный отказ при пересечении',async()=>{
  await cmd('category',{id:'legacy-child',amount_seasons:[{from:'12-01',to:'02-28',amount:2000}]});
  assert.equal(familyYearBudget(await get(),year+1).planned,15000,'три зимних месяца по 2000, остальные по 1000');
  await assert.rejects(cmd('category',{id:'legacy-child',amount_seasons:[{from:'12-01',to:'02-28',amount:2000},{from:'02-28',to:'03-01',amount:3000}]}),/constraint/);
  await assert.rejects(cmd('category',{id:'legacy-child',season_from:'11-31',season_to:'12-31'}),/существующую дату/);
  assert.equal(familyYearBudget(await get(),year+1).planned,15000);
  assert.deepEqual(row(await get(),'p1'),fixed);
});
test.after(async()=>{await db.close();});
