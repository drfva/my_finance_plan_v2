/* Изолированный предпросмотр на настоящем SQL в PGlite. Нет подключений к
   удалённой базе и отправки писем. Все имена/данные здесь вымышленные.
   FINANCE_PGLITE_MODULE=/.../pglite/dist/index.js node tools/preview/family-server.mjs */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runFamilyMember } from '../../src/core/family-worker.js';
const entry=process.env.FINANCE_PGLITE_MODULE?pathToFileURL(process.env.FINANCE_PGLITE_MODULE).href:'@electric-sql/pglite';
const { PGlite }=await import(entry);
const { pgcrypto }=await import(process.env.FINANCE_PGLITE_MODULE?new URL('contrib/pgcrypto.js',entry).href:'@electric-sql/pglite/contrib/pgcrypto');
const root=fileURLToPath(new URL('../../',import.meta.url));
const db=new PGlite({extensions:{pgcrypto}});
await db.exec('create role service_role nologin bypassrls');
await db.exec(await fs.readFile(path.join(root,'tests/000_supabase_stub.sql'),'utf8'));
for(const file of (await fs.readdir(path.join(root,'v2/sql'))).filter(f=>/^\d/.test(f)&&!f.startsWith('000')).sort())await db.exec(await fs.readFile(path.join(root,'v2/sql',file),'utf8'));
for (const file of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
const A='aaaaaaaa-0000-0000-0000-000000000001',B='bbbbbbbb-0000-0000-0000-000000000002',C='cccccccc-0000-0000-0000-000000000003';
const users={a:{id:A,email:'anna@example.test'},b:{id:B,email:'sasha@example.test'},c:{id:C,email:'guest@example.test'}};
await db.query('insert into auth.users(id,email) values($1,$2),($3,$4),($5,$6)',[A,users.a.email,B,users.b.email,C,users.c.email]);
let chain=Promise.resolve();
function rpc(user,name,args={},role='authenticated'){
  const task=chain.catch(()=>{}).then(async()=>{
    await db.exec('begin');try{
      await db.exec(`set local role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user||'']);
      const keys=Object.keys(args),values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
      const result=await db.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`,values);
      await db.exec('commit');return result.rows[0].data;
    }catch(e){await db.exec('rollback');throw e;}
  });chain=task;return task;
}
const cmd=async(user,action,payload={},familyId=family)=>{
  const f=familyId?await rpc(user,'family_get',{p_family:familyId}):null;
  return rpc(user,'family_command',{p_action:action,p_family:familyId,p_payload:payload,p_version:f?.version??null,p_request:crypto.randomUUID()});
};
const personal=(await rpc(A,'bootstrap_user',{p_title:'Личный план Анны'})).account.id;
// Общий доступ выдан до первого входа: он не должен заменить личный план.
for(const [email,role] of [[users.b.email,'editor'],[users.c.email,'viewer']])
  await rpc(A,'add_account_member',{p_account:personal,p_email:email,p_role:role});
const other=(await rpc(B,'bootstrap_user',{p_title:'Личный план Саши'})).account.id;
await rpc(C,'bootstrap_user',{p_title:'Личный план гостя'});
const family=(await cmd(A,'create',{title:'Наш семейный план'},null)).family_id;
// Второй участник — только демонстрационная заготовка; приём приглашения тестируется отдельно.
await db.query("insert into public.account_members(account_id,user_id,role) values($1,$2,'owner')",[family,B]);
await db.query("insert into public.family_members(family_id,user_id,email,nickname,color) values($1,$2,$3,$4,'green')",[family,B,'sasha@example.test','Саша']);
await cmd(A,'profile',{nickname:'Анна',color:'purple'});
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const month=today.slice(0,7),next=new Date(`${month}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
const nextMonth=next.toISOString().slice(0,7);
for(const [user,source,amount,date] of [[A,personal,500000,today],[B,other,60000,`${nextMonth}-05`]]){
  const state=await rpc(user,'state_get',{p_account:source});
  const periods=[{id:'p1',year:Number(date.slice(0,4)),pay_date:date,window_start:date.slice(0,7)+'-01',window_end:date,calc_mode:'manual',income_net:amount,taxable:false}];
  if(user===A)periods.push({id:'p2',year:Number(nextMonth.slice(0,4)),pay_date:`${nextMonth}-05`,window_start:`${nextMonth}-01`,window_end:`${nextMonth}-15`,calc_mode:'manual',income_net:200000,taxable:false});
  if(user===A)for(const offset of [1,2]){
    const year=Number(today.slice(0,4))+offset,date=`${year}-01-05`;
    periods.push({id:`next-${offset}`,year,pay_date:date,window_start:`${year}-01-01`,window_end:`${year}-01-15`,calc_mode:'manual',income_net:150000,taxable:false});
  }
  await rpc(user,'state_save',{p_domain:'income',p_patch:{periods},p_account:source,p_version:state.versions.income});
  await cmd(user,'rule',{source_account_id:source,revision:0,rule:{mode:user===A?'percent':'monthly',percent:20,amount:40000,cap_per_payment:user===B?15000:null,effective_from:today}});
}
await cmd(A,'category',{id:'food',title:'Продукты'});
await cmd(A,'category',{id:'home',title:'Дом и коммунальные услуги'});
await cmd(A,'expense',{category_id:'food',month,amount:50000});
await cmd(A,'expense',{category_id:'home',month,amount:30000});
await cmd(A,'fact',{category_id:'food',month,amount:45000});
await cmd(A,'fact',{category_id:'home',month,amount:30000});
await cmd(A,'expense',{category_id:'food',month:nextMonth,amount:50000});
await cmd(A,'expense',{category_id:'home',month:nextMonth,amount:40000});
const members=await rpc(null,'family_worker_members',{},'service_role');
for(const memberId of members)await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId,post:true});
if(process.env.FINANCE_GUIDE_PREVIEW==='1'){
  const {seedGuideData}=await import('./guide-data.mjs');
  try { await seedGuideData({rpc,user:A,account:personal,today}); }
  catch(error){console.error('Не удалось подготовить примеры руководства:',error.message);process.exit(1);}
  for(const memberId of members)await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId,post:false});
}
const allowed=new Set(['bootstrap_user','state_get','state_save','family_command','family_get','family_history','family_history_page','log_client_event','account_deletion_preview','account_assign_owner','delete_my_account']);
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  const address=new URL(req.url,'http://localhost');
  try{
    if(address.pathname==='/rpc'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks));
      if(!allowed.has(payload.name))return json(res,{error:{message:'RPC не разрешён в предпросмотре'}},400);
      try{return json(res,{data:await rpc((users[address.searchParams.get('user')]||users.a).id,payload.name,payload.args),error:null});}
      catch(e){return json(res,{data:null,error:{message:e.message,code:e.code},status:e.code==='PT409'?409:400});}
    }
    if(address.pathname==='/refresh'&&req.method==='POST'){
      const actor=(users[address.searchParams.get('user')]||users.a).id;
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
      const ids=await rpc(null,'family_worker_members',{p_actor:actor,p_source:body.source_account_id??null},'service_role');
      for(const memberId of ids)await runFamilyMember({rpc:(name,args)=>rpc(null,name,args,'service_role'),memberId,actor,post:false});
      return json(res,{data:{processed:ids.length},error:null});
    }
    if(address.pathname==='/mailbox'){
      const user=users[address.searchParams.get('user')]||users.c;
      const letters=await db.query('select o.token from family_api.mail_outbox o join public.family_invitations i on i.id=o.invitation_id where i.email=$1 and i.status=$2',[user.email,'pending']);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<html lang="ru"><meta charset="utf-8"><h1>Тестовая почта — имитация доставки</h1>${letters.rows.map((letter,i)=>`<p><a href="/?user=${Object.keys(users).find(k=>users[k]===user)}&family_invite=${encodeURIComponent(letter.token)}">Открыть приглашение ${i+1}</a></p>`).join('')}</html>`);
    }
    if(address.pathname==='/'){
      const user=Object.hasOwn(users,address.searchParams.get('user'))?address.searchParams.get('user'):'a';
      const theme=['light','dark'].includes(address.searchParams.get('theme'))?` data-theme="${address.searchParams.get('theme')}"`:'';
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!doctype html><html lang="ru"${theme}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Семейный план · предпросмотр</title><link rel="stylesheet" href="/src/ui/styles.css"></head><body><div id="root"></div><div id="login-screen" style="display:none"></div><script>
      window.APP_CONFIG={env:'dev',url:'',key:''};
      ${process.env.FINANCE_GUIDE_PREVIEW==='1'?`// Вымышленный курс только для локального руководства; без внешних запросов.
      const originalFetch=window.fetch.bind(window);
      window.fetch=(url,options)=>String(url)==='https://www.cbr-xml-daily.ru/daily_json.js'
        ?Promise.resolve(new Response(JSON.stringify({Date:'${today}T11:30:00+03:00',PreviousDate:'${today}T11:30:00+03:00',
          Valute:{USD:{CharCode:'USD',Nominal:1,Value:100,Previous:100},EUR:{CharCode:'EUR',Nominal:1,Value:110,Previous:110}}}),{status:200}))
        :originalFetch(url,options);`:''}
      const call=(name,args)=>fetch('/rpc?user=${user}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json());
      window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'${users[user].id}'}}}}),getUser:async()=>({data:{user:{id:'${users[user].id}',email:'${users[user].email}'}}}),signOut:async()=>{}},
      rpc:(name,args)=>call(name,args),functions:{invoke:(name,options)=>fetch('/refresh?user=${user}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options?.body||{})}).then(r=>r.json())}})};
      </script><script type="module" src="/src/main.js"></script></body></html>`);
    }
    const decoded=decodeURIComponent(address.pathname);
    const absolute=path.resolve(root,'.'+decoded);
    const folder=decoded.startsWith('/src/')?'src':decoded.startsWith('/help/')?'help':null;
    if(!folder||absolute!==path.join(root,folder)&&!absolute.startsWith(path.join(root,folder)+path.sep))return json(res,{error:'Not found'},404);
    const file=decoded.endsWith('/')?path.join(absolute,'index.html'):absolute;
    const type={'.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':type});res.end(await fs.readFile(file));
  }catch(e){json(res,{error:e.message},500);}
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/?plan=${family}`,pid:process.pid})));
