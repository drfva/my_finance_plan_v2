/* Одна и та же арифметика в браузере и на сервере. Этот модуль не запускается
   при отрисовке: проводить взносы может только защищённая серверная задача. */
import { createConfig } from './config.js';
import { simulate, freezePeriods } from '../engine/allocation.js';
import { computeIncome, classifyIncomePeriods } from '../engine/income.js';
import { familyToday } from '../engine/family.js';

export async function runFamilyMember({ rpc, memberId, actor = null, post = false, now = new Date() }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await rpc('family_worker_read', { p_member: memberId, p_actor: actor });
    const cfg = createConfig(state), round = cfg.formatter().round;
    const flags = new Map(classifyIncomePeriods(computeIncome(state,cfg,{round})).map(p=>[p.id,p.manual]));
    for (const p of state.income.periods ?? []) if (flags.has(p.id)) p.income_manual = flags.get(p.id);
    const today = familyToday(now);
    const sim = simulate(state, cfg, { round, today });
    const rows = sim.rows.filter(r => r.familyContribution?.member_id === memberId && !r.familyContribution.posted);
    let waiting = false;
    const due = post ? rows.filter(r => {
      if (r.period.pay_date > today) return false;
      waiting ||= Boolean(r.income.formula?.error || r.income.formula?.overpaid || r.income.sickPendingTax || r.income.sick?.pendingTax);
      return !waiting;
    }) : [];
    const dueIds = new Set(due.map(r => r.period.id));
    // Неполный расчёт больничного не фиксируем нулём. Последующие выплаты
    // тоже ждут: иначе журнал FIFO запомнит их раньше нерешённой выплаты.
    const freeze = post ? freezePeriods(state, sim, [...dueIds], round) : {};
    try {
      return await rpc('family_worker_commit', { p_member: memberId, p_revision: state.family_job_revision,
        p_versions: state.versions, p_rows: rows.map(r => r.familyContribution), p_freeze: freeze, p_post: post });
    } catch (error) {
      if (error.code !== 'PT409' || attempt === 2) throw error;
    }
  }
}

export async function sendFamilyInvites({ rpc, request, url, headers, appUrl, actor }) {
  if (!appUrl) return { configured:false,sent:0 };
  const site = new URL(appUrl);
  if (site.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(site.hostname)) throw new Error('FAMILY_APP_URL должен использовать HTTPS');
  const invites = await rpc('family_mail_claim',{p_actor:actor});
  let sent=0;
  for (const invitation of invites) {
    let error=null;
    try {
      const redirect=new URL(site);redirect.searchParams.set('family_invite',invitation.token);
      const query=new URLSearchParams({redirect_to:redirect.href});
      let response=await request(`${url}/auth/v1/invite?${query}`,{method:'POST',headers,body:JSON.stringify({email:invitation.email})});
      if (!response.ok) {
        const problem=await response.json().catch(()=>({}));
        if ([409,422].includes(response.status)||['email_exists','user_already_exists'].includes(problem.error_code||problem.code)) {
          response=await request(`${url}/auth/v1/otp?${query}`,{method:'POST',headers,
            body:JSON.stringify({email:invitation.email,create_user:false})});
        }
      }
      if (!response.ok) error=`mail_http_${response.status}`; else sent++;
    } catch { error='mail_network_error'; }
    await rpc('family_mail_ack',{p_invitation:invitation.id,p_lease:invitation.lease,p_error:error});
  }
  return { configured:true,sent };
}

export function createFamilyWorker({ env, fetch: request = fetch, now = () => new Date() }) {
  const url = env('SUPABASE_URL'), service = env('SUPABASE_SERVICE_ROLE_KEY');
  // CORS сравнивает origin без пути и завершающего '/'. В Secrets нередко
  // вставляют полный адрес сайта; нормализуем его, не отражая чужой Origin.
  let origin = 'null';
  for (const value of [env('FAMILY_APP_ORIGIN'),env('FAMILY_APP_URL')]) {
    if (!value) continue;
    try {
      const parsed = new URL(value.trim());
      if (!['https:','http:'].includes(parsed.protocol)) continue;
      origin = parsed.origin; break;
    } catch { /* Пробуем полный адрес приложения, если origin не задан. */ }
  }
  const headers = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' };
  const rpc = async (name, args) => {
    const response = await request(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.message || 'Ошибка семейной операции'), { code: value.code });
    return value;
  };
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-retry-count, traceparent, tracestate, baggage',
    'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
  return async req => {
    if (req.method === 'OPTIONS') return reply({});
    if (req.method !== 'POST') return reply({ error: 'Требуется POST' }, 405);
    if (!url || !service) return reply({ error: 'Серверная задача не настроена' }, 503);
    const secret = env('FAMILY_CRON_SECRET');
    const cron = Boolean(secret && req.headers.get('x-family-cron-secret') === secret);
    let actor = null;
    try {
      if (!cron) {
        const token = req.headers.get('Authorization');
        if (!token?.startsWith('Bearer ')) return reply({ error: 'Нужно войти' }, 401);
        const response = await request(`${url}/auth/v1/user`, { headers: { apikey: service, Authorization: token } });
        if (!response.ok) return reply({ error: 'Сессия недействительна' }, 401);
        actor = (await response.json()).id;
        if (!actor) return reply({ error: 'Сессия недействительна' }, 401);
      }
      const body=await req.json().catch(()=>({}));
      const requested=cron&&Array.isArray(body.member_ids)?body.member_ids:null;
      if(requested&&(requested.length>10||requested.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))))return reply({error:'Неверный пакет участников'},400);
      const mail=await sendFamilyInvites({rpc,request,url,headers,appUrl:env('FAMILY_APP_URL'),actor});
      let after = null, processed = 0;
      const errors = [];
      for (let batch = 0; batch < 10; batch++) {
        const members = requested || await rpc('family_worker_members', { p_actor: actor, p_after: after,p_source:cron?null:body.source_account_id??null });
        for (const memberId of members) {
          try { await runFamilyMember({ rpc, memberId, actor, post: cron, now: now() }); processed++; }
          catch (e) { errors.push({ member_id: memberId, code: e.code || 'error' }); }
        }
        if (requested || members.length < 10) break;
        after = members.at(-1);
      }
      return reply({ processed, errors, mail }, errors.length ? 207 : 200);
    } catch (e) { return reply({ error: e.code || 'Ошибка серверной задачи' }, 500); }
  };
}
