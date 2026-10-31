import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFamilyWorker, sendFamilyInvites } from '../src/core/family-worker.js';

const member='aaaaaaaa-1111-1111-1111-111111111111',user='aaaaaaaa-0000-0000-0000-000000000001';
function server() {
  const state=JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
  state.income={periods:[{id:'p',year:2026,pay_date:'2026-11-01',window_start:'2026-11-01',window_end:'2026-11-15',calc_mode:'manual',income_net:100000,taxable:false}]};
  state.expenses={};state.debts={};state.savings={};state.gifts={};
  state.family_private={membership:{id:member,family_id:'family',source_account_id:state.account.id,active:true},rules:[{mode:'percent',percent:20,effective_from:'2026-10-01'}]};
  state.family_job_revision=1;
  const calls=[];
  const handler=createFamilyWorker({env:key=>({SUPABASE_URL:'https://db.example.test',SUPABASE_SERVICE_ROLE_KEY:'server-only-key',FAMILY_CRON_SECRET:'server-scheduler-secret',FAMILY_APP_ORIGIN:'https://app.example.test'})[key],
    now:()=>new Date('2026-10-31T22:00:00Z'),fetch:async(url,options)=>{
      if(url.endsWith('/auth/v1/user'))return Response.json({id:user});
      const name=url.split('/').at(-1),args=JSON.parse(options.body);calls.push({name,args});
      if(name==='family_worker_members')return Response.json([member]);
      if(name==='family_worker_read')return Response.json(structuredClone(state));
      if(name==='family_worker_commit')return Response.json({posted:args.p_post?1:0});
      throw new Error('Неожиданный запрос');
    }});
  return {handler,calls,state};
}

test('сервер семьи: браузер не может провести взнос через подмену тела запроса',async()=>{
  const s=server();
  const response=await s.handler(new Request('https://worker.example.test',{method:'POST',headers:{Authorization:'Bearer valid-user-token','Content-Type':'application/json'},body:JSON.stringify({post:true,member_ids:[member]})}));
  assert.equal(response.status,200);
  const command=s.calls.find(c=>c.name==='family_worker_commit');
  assert.equal(command.args.p_post,false);
  assert.deepEqual(command.args.p_freeze,{});
  assert.equal(s.calls.find(c=>c.name==='family_worker_members').args.p_actor,user);
  assert.equal(JSON.stringify(await response.json()).includes('income_net'),false);
});

test('сервер семьи: расписание проводит по московской дате и фиксирует источник',async()=>{
  const s=server();
  const response=await s.handler(new Request('https://worker.example.test',{method:'POST',headers:{'x-family-cron-secret':'server-scheduler-secret','Content-Type':'application/json'},body:JSON.stringify({member_ids:[member]})}));
  assert.equal(response.status,200);
  const command=s.calls.find(c=>c.name==='family_worker_commit');
  assert.equal(command.args.p_post,true);
  assert.equal(command.args.p_rows[0].amount,20000);
  assert.equal(command.args.p_freeze.periods[0].locked,true);
  assert.equal(s.calls.some(c=>c.name==='family_worker_members'),false,'пакет Cron обработан целиком');
});

test('сервер семьи: запрос без сессии и секрета не получает доступ к базе',async()=>{
  const s=server();
  const response=await s.handler(new Request('https://worker.example.test',{method:'POST',body:'{}'}));
  assert.equal(response.status,401);
  assert.equal(s.calls.length,0);
});

test('сервер семьи: незавершённый больничный сохраняет прогнозы, не фиксируя его и последующие выплаты',async()=>{
  const s=server();
  s.state.income.periods=[
    {id:'pending',year:2026,pay_date:'2026-10-31',window_start:'2026-10-16',window_end:'2026-10-31',calc_mode:'auto',income_manual:true,income_net:100000},
    {id:'later',year:2026,pay_date:'2026-11-01',window_start:'2026-11-01',window_end:'2026-11-01',calc_mode:'manual',income_net:10000,taxable:false},
  ];
  s.state.income.sick_leaves=[{id:'s',start_date:'2026-10-20',end_date:'2026-10-23',benefit_enabled:true,reason:'illness',insurance_years:8,
    earnings1:730000,earnings2:730000,district_coefficient:1,employment_fraction:1,employer_pay_date:'2026-10-30',sfr_pay_date:'2026-10-31'}];
  s.state.income.tax_scales=[];s.state.income.tax_brackets=[];
  const response=await s.handler(new Request('https://worker.test',{method:'POST',headers:{'x-family-cron-secret':'server-scheduler-secret'},body:JSON.stringify({member_ids:[member]})}));
  assert.equal(response.status,200);
  const command=s.calls.find(c=>c.name==='family_worker_commit');
  assert.equal(command.args.p_freeze.periods.some(p=>p.locked),false);
  assert.deepEqual(command.args.p_rows.map(r=>r.period_id),['pending','later']);
});

test('приглашения: существующий пользователь получает ссылку; подтверждение отправки без токенов в ответе',async()=>{
  const calls=[],acks=[];
  const result=await sendFamilyInvites({url:'https://db.example.test',headers:{apikey:'server-key'},appUrl:'https://app.example.test/plan/',actor:user,
    rpc:async(name,args)=>{
      if(name==='family_mail_claim')return [{id:'i',email:'guest@example.test',token:'test-invite-token',lease:'lease'}];
      if(name==='family_mail_ack'){acks.push(args);return null;}
    },request:async(url,options)=>{
      calls.push({url,body:JSON.parse(options.body)});
      return url.includes('/invite?')?Response.json({error_code:'email_exists'},{status:422}):Response.json({});
    }});
  assert.equal(calls.length,2);
  assert.equal(calls[1].body.create_user,false);
  const redirect=new URL(new URL(calls[1].url).searchParams.get('redirect_to'));
  assert.equal(redirect.origin,'https://app.example.test');
  assert.equal(redirect.searchParams.get('family_invite'),'test-invite-token');
  assert.equal(acks[0].p_error,null);
  assert.equal(result.sent,1);
  assert.equal(JSON.stringify(result).includes('token'),false);
});

test('приглашения: нового пользователя приглашаем один раз; ошибка сети сохраняется для повторной доставки',async()=>{
  for(const failure of [false,true]){
    const acks=[],calls=[];
    const result=await sendFamilyInvites({url:'https://db.example.test',headers:{},appUrl:'https://app.example.test/',actor:user,
      rpc:async(name,args)=>name==='family_mail_claim'?[{id:'i',email:'new@example.test',token:'token',lease:'lease'}]:acks.push(args),
      request:async(url)=>{calls.push(url);if(failure)throw new Error('offline');return Response.json({});}});
    assert.equal(calls.length,1);assert.match(calls[0],/\/invite\?/);
    assert.equal(acks[0].p_error,failure?'mail_network_error':null);
    assert.equal(result.sent,failure?0:1);
  }
});

test('сервер семьи: недоступный Auth возвращает контролируемую ошибку без обращения к финансовым данным',async()=>{
  let calls=0;
  const handler=createFamilyWorker({env:key=>({SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'server-key'})[key],
    fetch:async()=>{calls++;throw new Error('offline');}});
  const response=await handler(new Request('https://worker.test',{method:'POST',headers:{Authorization:'Bearer session'},body:'{}'}));
  assert.equal(response.status,500);assert.equal(calls,1);
});
