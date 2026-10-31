import { esc, card, section, table, field, pill } from './dom.js';
import { familyBudget, validateFamilyRule, familyToday } from '../engine/family.js';
import { addMonths } from '../engine/dates.js';
import { planSwitch, securityCard, handle as handleSettings } from './settings.js';
import { uid } from './edit.js';

export const FAMILY_TABS = ['dashboard','periods','categories','facts','settings','family-history'].map(code => ({
  code, title: () => ({ dashboard:'Обзор',periods:'Доходы',categories:'Категории',facts:'Расходы',settings:'Настройки','family-history':'История изменений' })[code],
  render: ctx => renderFamily(ctx,code), handle,
}));
const COLORS = { blue:'Голубой',pink:'Розовый',purple:'Фиолетовый',green:'Зелёный',orange:'Оранжевый' };
const nameOf = member => member?.nickname || member?.email || 'Участник';
const memberTag = member => `<span class="family-person family-${esc(member?.color || 'blue')}" title="${esc(member?.email || '')}"><i aria-hidden="true"></i>${esc(nameOf(member))}${member?.active === false ? ' · вышел' : ''}</span>`;
const draftOf = ctx => ctx.ui.draft[ctx.ui.tab] ?? {};
const monthOf = ctx => ctx.ui.draft.familyMonth || ctx.today.slice(0,7);
const textField = (name,value,extra='') => `<input data-draft="${esc(name)}" value="${esc(value??'')}" ${extra}>`;
const selectField = (name,value,entries,extra='') => `<select data-draft="${esc(name)}" ${extra}>${entries.map(([key,title])=>`<option value="${esc(key)}"${String(value)===key?' selected':''}>${esc(title)}</option>`).join('')}</select>`;
const action = (name,label,value='',cls='small') => `<button class="${cls}" data-family-action="${esc(name)}" data-value="${esc(value)}">${esc(label)}</button>`;

function monthNavigation(ctx) {
  const month = monthOf(ctx), [year,m] = month.split('-').map(Number);
  const shifted = step => { const d=addMonths(year,m,step);return `${d.y}-${String(d.m).padStart(2,'0')}`; };
  return `<div class="row between wrap family-month-nav">
    <div class="row" style="gap:10px;">${action('month','‹',shifted(-1),'ghost small')}
      <h2 style="margin:0;">${esc(ctx.fmt.month(month))}</h2>${action('month','›',shifted(1),'ghost small')}</div>
    ${action('refresh','Обновить прогноз','','ghost small')}</div>`;
}

export function personalFamilyCard(ctx) {
  if (!ctx.state.family_available) return '';
  const connection = ctx.state.family_connection, d = draftOf(ctx), today = familyToday();
  const panel=options=>section({key:'set:family',title:'Семейный план',open:ctx.ui.open.has('set:family'),...options});
  if (!connection) return panel({
    body:`<p class="small-note">Отдельный общий бюджет с отчислениями из личных выплат. Личные данные участников остаются в их планах.</p>
      <div class="row wrap" style="gap:12px;">${textField('family_title',d.family_title,'placeholder="Название семьи" style="max-width:340px;"')}
      ${action('create','Создать семейный план','','primary small')}</div>` });
  const member = ctx.state.family_private?.membership, rule = ctx.state.family_private?.rules?.at(-1);
  const form = { source_account_id:member?.source_account_id || ctx.state.account.id,
    mode:rule?.mode || 'monthly', amount:rule?.amount ?? 0, percent:rule?.percent ?? 0,
    effective_from:today, limit_scope:rule?.limit_scope || 'payment', limit_amount:rule?.limit_amount ?? '',
    limit_percent:rule?.limit_percent ?? '', cap_per_payment:rule?.cap_per_payment ?? '', ...d };
  const personal = (ctx.state.accounts??[]).filter(a=>a.plan_kind!=='family'&&a.id!==connection.id&&a.role!=='viewer');
  const sources = personal.map(a=>[a.id,a.title]);
  const fixed=['per_payment','monthly'].includes(form.mode);
  return panel({
    note:'Правило применяется к будущим незафиксированным выплатам. Проведённые взносы сохраняются. Позиция семейного этапа меняется в порядке распределения.',
    body:`<div style="margin-bottom:18px;"><b>${esc(connection.title)}</b></div>
    <div class="grid cols-3">
      ${field('Источник взносов',selectField('source_account_id',form.source_account_id,sources))}
      ${field('Способ отчислений',selectField('mode',form.mode,[['per_payment','Сумма с выплаты'],['monthly','Сумма за месяц'],['percent','Процент от дохода'],['remainder','Свободный остаток']],'data-family-reveal'))}
      ${field('Действует с',textField('effective_from',form.effective_from,`type="date" min="${today}"`))}
      ${fixed?field('Сумма, ₽',textField('amount',form.amount,'inputmode="decimal"'),form.mode==='monthly'?'Общий обязательный взнос за календарный месяц.':'Обязательный взнос с каждой выплаты.'):''}
      ${form.mode==='percent'?field('Процент от дохода, %',textField('percent',form.percent,'inputmode="decimal"'), 'От полной выплаты на руки, включая отпускные и больничный.'):''}
      ${form.mode!=='remainder'?field('Потолок с одной выплаты, ₽',textField('cap_per_payment',form.cap_per_payment,'inputmode="decimal" placeholder="Не ограничивать"'),'Максимум всего взноса с выплаты, включая погашение недобора.'):''}
    </div>${form.mode==='remainder'?`<div class="grid cols-3" style="margin-top:12px;">
      ${field('Область лимита',selectField('limit_scope',form.limit_scope,[['payment','На выплату'],['month','На месяц']]))}
      ${field('Не более суммы, ₽',textField('limit_amount',form.limit_amount,'inputmode="decimal" placeholder="Не ограничивать"'))}
      ${field('Не более остатка, %',textField('limit_percent',form.limit_percent,'inputmode="decimal" placeholder="Не ограничивать"'))}
    </div><p class="small-note">Лимит действует на выбранный период. Процент считается от свободного остатка на позиции семейного этапа. Неиспользованный лимит в следующий месяц не переносится.</p>
    ${field('Дополнительный потолок с одной выплаты, ₽',textField('cap_per_payment',form.cap_per_payment,'inputmode="decimal" placeholder="Не ограничивать"'),'Ограничивает весь взнос с одной выплаты, включая старый недобор. При месячном лимите защищает от списания всего лимита за один раз.')}<div style="margin-top:16px;"></div>`:''}
    ${action('rule','Сохранить свои отчисления','','primary small')}
    <p class="small-note">Семья получает только сведения о взносах. Суммы ваших доходов, личные расходы и это правило другим участникам не показываются.</p>` });
}

export function invitationCard(ctx) {
  if (!ctx.ui.draft.familyInvite) return '';
  return card({title:'Приглашение в семейный план',body:`<p>Принятие добавит вас в семью. Отчисления вы настроите самостоятельно в своём личном плане.</p>
    ${action('accept','Принять приглашение','','primary small')} ${action('dismiss-invite','Позже','','ghost small')}`});
}

export function familyContributionControl(ctx,c,{readonlyValue=true}={}) {
  const own=ctx.state.family_private,editable=ctx.canEdit&&own?.membership?.active
    &&own.membership.id===c.member_id&&!c.posted&&c.status!=='posted'&&c.pay_date>familyToday();
  const money=esc(ctx.fmt.money(c.amount));
  if(!editable)return readonlyValue?`<b>${money}</b>`:'';
  const override=own.overrides?.find(o=>o.period_id===c.period_id),manual=override?.amount!=null;
  return `<span class="family-contribution-control"><input class="num${manual?' own':''}" inputmode="decimal"
    data-family-edit="override" data-id="${esc(c.period_id)}" value="${esc(manual?override.amount:c.amount)}"
    aria-label="Мой будущий взнос ${esc(ctx.fmt.date(c.pay_date))}" style="max-width:150px;text-align:right;">
    ${manual?action('override-reset','По правилу',c.period_id,'ghost small'):''}</span>
    ${manual&&Math.abs(override.amount-c.amount)>.005?`<div class="small-note">В плане ${money}: с учётом округления источника, доступного остатка и потолков.</div>`:''}`;
}

export function familyRuleDescription(ctx,c) {
  if(c.posted||c.status==='posted')return 'Сумма зафиксирована при проведении';
  const own=ctx.state.family_private;
  if(c.member_id!==own?.membership?.id)return 'По правилу участника';
  const rule=(own.rules??[]).filter(r=>r.effective_from<=c.pay_date)
    .slice().sort((a,b)=>a.effective_from.localeCompare(b.effective_from)||(a.revision??0)-(b.revision??0)).at(-1);
  if(!rule)return 'Правило не действует на дату выплаты';
  const money=value=>ctx.fmt.money(Number(value)||0),percent=value=>String(Number(value)||0).replace('.',',');
  const parts=[rule.mode==='per_payment'?`${money(rule.amount)} с каждой выплаты`:rule.mode==='monthly'
    ?`${money(rule.amount)} за месяц, пропорционально выплатам`:rule.mode==='percent'
      ?`${percent(rule.percent)}% от полной выплаты на руки`:'Свободный остаток'];
  if(rule.mode==='remainder'){
    const scope=rule.limit_scope==='month'?'за месяц':'с выплаты';
    if(rule.limit_amount!=null)parts.push(`не более ${money(rule.limit_amount)} ${scope}`);
    if(rule.limit_percent!=null)parts.push(`не более ${percent(rule.limit_percent)}% свободного остатка ${scope}`);
  }
  if(rule.cap_per_payment!=null)parts.push(`потолок ${money(rule.cap_per_payment)} с выплаты`);
  if(own.overrides?.some(o=>o.period_id===c.period_id&&o.amount!=null))parts.push('сумма этой выплаты задана вручную');
  return parts.join('; ');
}

function overview(ctx) {
  const family = ctx.state.family, budget = familyBudget(family,monthOf(ctx));
  const stat = (label,value) => `<div class="card stat"><div class="v">${esc(ctx.fmt.money(value))}</div><div class="l">${label}</div></div>`;
  return `<div class="grid cols-3">${stat('Получено за месяц',budget.received)}${stat('Ожидаются взносы',budget.future)}${stat('Расходы по плану',budget.planned)}</div>
    ${card({ title:'Расчётный остаток месяца', body:`<div class="grid cols-2">
      <div><b class="family-balance${budget.balance<0?' danger-text':''}">${esc(ctx.fmt.money(budget.balance))}</b><p class="small-note">Полученные взносы минус весь план расходов месяца.</p></div>
      <div><b class="family-balance${budget.forecastBalance<0?' danger-text':''}">${esc(ctx.fmt.money(budget.forecastBalance))}</b><p class="small-note">Прогноз с учётом ожидаемых взносов и плана расходов.</p></div></div>
      <p class="small-note">Это расчёт бюджета месяца. Остатки других месяцев и статистический факт трат в него не включаются.</p>` })}
    ${incomes(ctx)}`;
}

function incomes(ctx) {
  const f = ctx.state.family, month = monthOf(ctx), members = new Map(f.members.map(m=>[m.id,m]));
  const list = f.contributions.filter(c=>c.pay_date.startsWith(month));
  const rows = list.map(c=>`<tr><td>${esc(ctx.fmt.date(c.pay_date))}</td><td>${memberTag(members.get(c.member_id))}</td>
    <td>${pill(c.status==='posted'?'получено':c.pay_date<=ctx.today?'ожидает проведения':'прогноз',c.status==='posted'?'ok':'')}
      ${c.arrears_amount>0?`<div class="small-note">Погашение недобора: ${esc(ctx.fmt.money(c.arrears_amount))}${c.settlements?.filter(s=>s.month<c.pay_date.slice(0,7)).map(s=>` · ${esc(ctx.fmt.month(s.month))}`).join('')||''}</div>`:''}</td>
    <td class="num">${familyContributionControl(ctx,c)}</td></tr>`);
  return card({title:'Семейные поступления',note:'Прогноз показан отдельно от полученных денег. Поступления проводятся автоматически в дату исходной выплаты.',
    body:table({head:['Дата','Участник','Состояние',{title:'На руки',cls:'num'}],rows:rows.length?rows:['<tr><td colspan="4" class="muted">Поступлений за месяц пока нет.</td></tr>']})});
}

function expenseTable(ctx, facts = false) {
  const f=ctx.state.family, month=monthOf(ctx), money=n=>esc(ctx.fmt.money(n));
  const planOf=id=>f.monthly_expenses.find(e=>e.category_id===id&&e.month===month)?.amount??0;
  const factOf=id=>f.expense_facts.find(e=>e.category_id===id&&e.month===month)?.amount??'';
  const rowClass=(planned,actual,hasFact=true)=>!facts||!hasFact?'fact-even':Math.abs(actual-planned)<=planned*(Number(ctx.cfg.get('fact_tolerance_pct'))||0)/100?'fact-even':actual>planned?'fact-over':'fact-under';
  const cellInput=(op,id,value)=>`<input class="num" inputmode="decimal" data-family-edit="${op}" data-id="${esc(id)}" value="${esc(value)}" style="max-width:150px;text-align:right;">`;
  const rows=[];
  const leaf=(c,label=c.title)=>`<tr class="${rowClass(planOf(c.id),Number(factOf(c.id)||0),factOf(c.id)!=='')}"><td>${esc(label)}</td>${facts?`<td class="num muted">${money(planOf(c.id))}</td>`:''}
    <td class="num">${cellInput(facts?'fact':'expense',c.id,facts?factOf(c.id):planOf(c.id))}</td>
    ${facts?`<td class="num diff">${factOf(c.id)===''?'':money(Number(factOf(c.id))-planOf(c.id))}</td>`:
      `<td>${c.parent_id?'':action('add-item','+ подстатья',c.id,'ghost small')} ${action('delete-category','✕',c.id,'ghost small')}</td>`}</tr>`;
  for (const c of f.categories.filter(c=>!c.parent_id)) {
    const items=f.categories.filter(i=>i.parent_id===c.id);
    if (!items.length) rows.push(leaf(c));
    else {
      const group=[c,...items], planned=group.reduce((s,x)=>s+Number(planOf(x.id)),0), actual=group.reduce((s,x)=>s+Number(factOf(x.id)||0),0);
      rows.push(`<tr class="${rowClass(planned,actual,group.some(x=>factOf(x.id)!==''))}"><td><b>${esc(c.title)}</b></td><td class="num"><b>${money(planned)}</b></td>${facts?`<td class="num">${money(actual)}</td><td class="num diff">${money(actual-planned)}</td>`:`<td>${action('add-item','+ подстатья',c.id,'ghost small')} ${action('delete-category','✕',c.id,'ghost small')}</td>`}</tr>`);
      if (planOf(c.id)||factOf(c.id)!=='') rows.push(leaf(c,'Без подстатьи'));
      rows.push(...items.map(i=>leaf(i,`↳ ${i.title}`)));
    }
  }
  const b=familyBudget(f,month);
  const heading=facts?['Категория / статья','План','Факт','Отклонение']:['Категория / статья','План на месяц',''];
  return card({title:facts?'План и статистический факт':'План расходов месяца',
    note:facts?'Факт влияет только на статистику. Расчётный остаток уменьшается по плану.':'Каждая сумма относится только к выбранному месяцу.',
    body:table({head:heading,rows:rows.length?rows:[`<tr><td colspan="${heading.length}" class="muted">Добавьте семейные категории.</td></tr>`],
      foot:`<tr><td><b>Итого</b></td><td class="num"><b>${money(b.planned)}</b></td>${facts?`<td class="num"><b>${money(b.actual)}</b></td><td class="num">${money(b.deviation)}</td>`:'<td></td>'}</tr>`})});
}

function categories(ctx) {
  const d=draftOf(ctx), f=ctx.state.family;
  const rename=f.categories.map(c=>`<div class="row" style="gap:10px;margin:8px 0;">
    <input data-family-edit="category" data-id="${esc(c.id)}" value="${esc(c.title)}" aria-label="Название ${c.parent_id?'подстатьи':'категории'}">${action('delete-category','✕',c.id,'ghost small')}</div>`).join('');
  return `${expenseTable(ctx)}${card({title:'Категории семьи',body:`${rename}<div class="row wrap" style="gap:12px;margin-top:16px;">
    ${textField('category_title',d.category_title,'placeholder="Новая категория" style="max-width:320px;"')}${action('add-category','+ категория','','primary small')}</div>`})}`;
}

function ownMember(ctx,member) {
  const d=draftOf(ctx),color=d.color??member.color,open=ctx.ui.open.has('family-palette');
  return `<div class="family-profile-inline">
    <span class="family-person family-${esc(color)}">
      <button class="family-color-toggle" data-family-action="palette-toggle" aria-label="Выбрать мой цвет" title="Выбрать мой цвет" aria-expanded="${open}" aria-controls="family-palette"><i aria-hidden="true"></i></button>
      <input class="family-nickname" data-family-profile="nickname" aria-label="Мой никнейм" maxlength="40" autocomplete="nickname"
        value="${esc(d.nickname??member.nickname)}" placeholder="${esc(member.email)}" title="Изменить свой никнейм">
    </span>
    ${open?`<div id="family-palette" class="family-palette" role="group" aria-label="Мой цвет">${Object.entries(COLORS).map(([code,title])=>
      `<button class="family-swatch family-${code}" data-family-action="profile-color" data-value="${code}" aria-label="${title}" title="${title}" aria-pressed="${color===code}">${color===code?'<span aria-hidden="true">✓</span>':''}</button>`).join('')}</div>`:''}
  </div>`;
}

function invitationStatus(invitation) {
  if(invitation.status==='accepted')return 'Добро пожаловать в семью';
  if(invitation.status==='revoked')return 'Приглашение отозвано';
  if(new Date(invitation.expires_at).getTime()<=Date.now())return 'Срок приглашения истёк';
  return invitation.delivery==='sent'?'Приглашение отправлено':invitation.delivery==='error'?'Ошибка отправки приглашения':'Приглашение ожидает отправки';
}

function settings(ctx) {
  const f=ctx.state.family,d=draftOf(ctx),self=f.members.find(m=>m.is_self);
  const invitations=self?.role==='owner'?`<div class="family-invitations"><h3>Пригласить в семью</h3>
    <div class="row wrap" style="gap:12px;margin-top:12px;">${textField('invite_email',d.invite_email,'type="email" placeholder="Почта участника" aria-label="Почта участника" style="max-width:340px;"')}${action('invite','Пригласить по почте','','primary small')}</div>
    ${(f.invitations??[]).map(i=>`<div class="row between wrap" style="gap:8px;margin-top:12px;"><span>${esc(i.email)} · ${invitationStatus(i)}</span>
      ${i.status==='pending'?action('revoke','Отозвать',i.id,'ghost small'):''}</div>`).join('')}</div>`:'';
  return `${section({key:'set:plan',title:'Семейный план',open:ctx.ui.open.has('set:plan'),body:`<div class="grid cols-2">
      <div>${field('Название семейного плана',textField('family_title',d.family_title??f.title,'maxlength="160"'))}
        <div style="margin-top:12px;">${action('rename','Сохранить название','','primary small')}</div></div>
      ${field('Ваша роль','<div style="padding-top:8px;">владелец</div>')}</div>${planSwitch(ctx)}`})}
    ${card({title:'Участники семьи',actions:action('leave','Уйти за хлебом и не вернуться','','ghost small family-leave'),
      note:'Все участники — владельцы общего плана. Нажмите на свой никнейм, чтобы изменить его, и на кружок рядом — чтобы выбрать цвет.',
      body:`<div class="family-members">${f.members.map(m=>`<div class="row between wrap family-member-row">
        ${m.is_self&&m.active?ownMember(ctx,m):memberTag(m)}<span class="small-note">${m.role==='owner'?'владелец':'участник'}</span>
        ${self?.role==='owner'&&m.active&&!m.is_self?action('remove','Исключить',m.id,'ghost small'):''}</div>`).join('')}</div>
      ${invitations}<p class="small-note">После ухода будущие взносы и добор недостачи прекращаются. Совершённые поступления и история сохраняются.</p>`})}
    ${securityCard(ctx)}`;
}

function renderHistory(ctx) {
  const labels={families:'Семейный план',family_categories:'Категории',family_monthly_expenses:'План расходов',family_expense_facts:'Статистический факт',family_contributions:'Взнос',family_members:'Участники',family_invitations:'Приглашение'};
  const actions={INSERT:'Создано',UPDATE:'Изменено',DELETE:'Удалено'};
  const fields={title:'Название',month:'Месяц',amount:'Сумма',nickname:'Никнейм',color:'Цвет',role:'Роль',active:'Участие',email:'Почта',
    status:'Состояние',pay_date:'Дата поступления',current_amount:'Текущий взнос',arrears_amount:'Погашение недобора',expires_at:'Срок приглашения',deleted:'План удалён'};
  const status={posted:'получено',forecast:'прогноз',pending:'ожидает принятия',accepted:'принято',revoked:'отозвано'};
  const value=(key,v)=>v==null?'—':['amount','current_amount','arrears_amount'].includes(key)?ctx.fmt.money(v):key==='color'?COLORS[v]||v:key==='active'?v?'участвует':'вышел':key==='role'?v==='owner'?'владелец':'участник':key==='status'?status[v]||v:String(v);
  const details=a=>table({head:['Поле','До','После'],rows:Object.entries(fields).filter(([key])=>JSON.stringify(a.before_data?.[key])!==JSON.stringify(a.after_data?.[key]))
    .map(([key,label])=>`<tr><td>${label}</td><td>${esc(value(key,a.before_data?.[key]))}</td><td>${esc(value(key,a.after_data?.[key]))}</td></tr>`)});
  const rows=ctx.state.family.audit.map(a=>`<tr><td>${esc(new Date(a.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}))}</td><td>${esc(a.actor_name)}${a.actor_kind==='system'?' · автоматически':''}</td>
    <td>${esc(labels[a.object_type]||a.object_type)} · ${esc(actions[a.action]||a.action)}</td><td><details><summary>Изменения</summary>
      ${details(a)}</details></td></tr>`);
  return card({title:'История изменений',note:'Автор, время по Москве и сохранённые значения до и после изменения.',
    body:table({head:['Когда','Кто','Действие','Что изменилось'],rows:rows.length?rows:['<tr><td colspan="4" class="muted">История пока пуста.</td></tr>']})
      + (ctx.state.family.audit_has_more!==false&&rows.length>=200?action('history-more','Более ранние изменения','','ghost small'):'')});
}

export function renderFamily(ctx,code) {
  return `${code==='settings'||code==='family-history'?'':monthNavigation(ctx)}${code==='dashboard'?overview(ctx):code==='periods'?incomes(ctx):code==='categories'?categories(ctx):code==='facts'?expenseTable(ctx,true):code==='settings'?settings(ctx):renderHistory(ctx)}`;
}

export function handleChange(ev,ctx) {
  const profile=ev.target.closest('[data-family-profile]');
  if(profile){
    const self=ctx.state.family?.members.find(m=>m.is_self&&m.active);
    if(!self||profile.dataset.familyProfile!=='nickname')return true;
    const d=ctx.ui.draft[ctx.ui.tab]??(ctx.ui.draft[ctx.ui.tab]={});
    d.nickname=profile.value;
    ctx.store.familyCommand('profile',{nickname:d.nickname,color:d.color??self.color})
      .catch(e=>ctx.notice('danger',e.message));return true;
  }
  const el=ev.target.closest('[data-family-edit]'); if(!el)return false;
  const op=el.dataset.familyEdit;
  const amount=el.value.trim()===''?null:ctx.fmt.parseMoney(el.value);
  if(op!=='category'&&el.value.trim()!==''&&(amount===null||amount<0)){ctx.notice('danger','Введите неотрицательную сумму');return true;}
  const override=ctx.state.family_private?.overrides?.find(o=>o.period_id===el.dataset.id);
  const category=ctx.state.family?.categories.find(c=>c.id===el.dataset.id);
  const payload=op==='override'?{period_id:el.dataset.id,amount,revision:override?.revision??0,
    source_account_id:ctx.state.family_private?.membership?.source_account_id}:op==='category'?{...category,title:el.value}:{category_id:el.dataset.id,month:monthOf(ctx),amount};
  ctx.store.familyCommand(op,payload).then(result=>{if(result.warning)ctx.notice('warn',result.warning);}).catch(e=>ctx.notice('danger',e.message)); return true;
}

export function handle(ev,ctx) {
  const el=ev.target.closest('[data-family-action]'); if(!el)return handleSettings(ev,ctx);
  const op=el.dataset.familyAction,value=el.dataset.value,d=ctx.ui.draft[ctx.ui.tab]??(ctx.ui.draft[ctx.ui.tab]={});
  if(op==='month'){ctx.ui.draft.familyMonth=value;return true;}
  if(op==='dismiss-invite'){delete ctx.ui.draft.familyInvite;return true;}
  if(op==='open'){ctx.store.switchAccount(value).catch(e=>ctx.notice('danger',e.message));return true;}
  if(op==='palette-toggle'){
    if(ctx.ui.open.has('family-palette'))ctx.ui.open.delete('family-palette');else ctx.ui.open.add('family-palette');
    return true;
  }
  const run=async()=>{
    if(op==='refresh'){await ctx.store.refreshFamilyForecast();return;}
    if(op==='history-more'){await ctx.store.familyHistory();return;}
    let payload={}; let actionName=op;
    if(op==='create')payload={title:d.family_title};
    else if(op==='rename')payload={title:d.family_title??ctx.state.family.title};
    else if(op==='profile-color'){
      const self=ctx.state.family.members.find(m=>m.is_self&&m.active);
      if(!self||!Object.hasOwn(COLORS,value))return;
      d.color=value;ctx.ui.open.delete('family-palette');actionName='profile';
      payload={nickname:d.nickname??self.nickname,color:value};
    }
    else if(op==='rule'){
      const latest=ctx.state.family_private?.rules?.at(-1)??{};
      const number=(key,fallback=0)=>{
        if(d[key]===undefined)return latest[key]??fallback;if(d[key]==='')return null;
        const n=key.includes('percent')?ctx.fmt.parseNumber(d[key]):ctx.fmt.parseMoney(d[key]);
        if(n===null)throw new Error('Введите число в сумме или проценте');return n;
      };
      const mode=d.mode??latest.mode??'monthly';
      const rule={mode,effective_from:d.effective_from??familyToday(),
        amount:['per_payment','monthly'].includes(mode)?number('amount'):0,percent:mode==='percent'?number('percent'):0,
        cap_per_payment:number('cap_per_payment',null),limit_amount:mode==='remainder'?number('limit_amount',null):null,
        limit_percent:mode==='remainder'?number('limit_percent',null):null,limit_scope:mode==='remainder'?d.limit_scope??latest.limit_scope??'payment':'payment'};
      validateFamilyRule(rule);payload={source_account_id:d.source_account_id??ctx.state.family_private?.membership?.source_account_id??ctx.state.account.id,
        revision:ctx.state.family_private?.membership?.revision??0,rule};
    }else if(op==='add-category'||op==='add-item'){
      const title=op==='add-item'?prompt('Название подстатьи'):d.category_title;
      if(!title?.trim())return;
      actionName='category';payload={id:uid('family-cat'),title:title.trim(),parent_id:op==='add-item'?value:null,sort_order:ctx.state.family?.categories.length??0};
    }else if(op==='delete-category'){
      if(!confirm('Удалить категорию вместе с подстатьями, планом и статистическим фактом? Изменение останется в истории.'))return;
      actionName='delete_category';payload={id:value};
    }else if(op==='invite')payload={email:d.invite_email};
    else if(op==='accept')payload={token:ctx.ui.draft.familyInvite};
    else if(op==='revoke'||op==='remove'){
      if(op==='remove'&&!confirm('Исключить участника? Его будущие взносы прекратятся, проведённая история сохранится.'))return;
      payload={id:value};
    }else if(op==='override-reset'){
      actionName='override';payload={period_id:value,amount:null,source_account_id:ctx.state.family_private.membership.source_account_id,
        revision:ctx.state.family_private.overrides?.find(o=>o.period_id===value)?.revision??0};
    }else if(op==='leave'){
      const last=ctx.state.family.members.filter(m=>m.active).length===1;
      const warning='Вы точно хотите покинуть семью, оставить детей, собаку и даже того паука Гришу?';
      if(!confirm(warning+(last?'\n\nВы последний участник. Семейный план будет удалён, а будущие взносы прекращены. Проведённые взносы останутся в личной истории.':'')))return;
      payload={confirm_delete:last};
    }
    const result=await ctx.store.familyCommand(actionName,payload);
    if(result.warning)ctx.notice('warn',result.warning);
    if(op==='create'||op==='accept'){
      delete ctx.ui.draft.familyInvite;
      const url=new URL(location.href);url.searchParams.delete('family_invite');window.history.replaceState(null,'',url);
      await ctx.store.switchAccount(result.family_id);
    }
    if(op==='leave') {const other=ctx.store.state.accounts.find(a=>a.id!==ctx.state.account.id);if(other)await ctx.store.switchAccount(other.id);}
  };
  run().catch(e=>ctx.notice('danger',e.message));return true;
}
