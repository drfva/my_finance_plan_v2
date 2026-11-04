import { esc, card, table, field, pill } from './dom.js';
import { uid } from './edit.js';
import { familyBudget, familyYearBudget } from '../engine/family.js';
import { inSeason, inSeasonMonth } from '../engine/expenses.js';
import { expenseAmountOn } from '../engine/expense-seasons.js';
import { amountSeasons, amountSeasonHandle, amountSeasonChange } from './expense-seasons.js';

const activeCategories = ctx => ctx.state.family.categories.filter(c => !c.archived);
const yearMonth = ctx => `${ctx.year}-${ctx.today.slice(5,7)}`;
const monthOf = ctx => ctx.ui.draft.familyFactMonth?.startsWith(String(ctx.year)) ? ctx.ui.draft.familyFactMonth : yearMonth(ctx);
const budgetRow = (ctx,c) => ctx.state.family.budget?.rows?.find(r=>r.contribution_id===c.id) ?? {allocations:[],expenses:0,locked:c.status==='posted'};
const act = (action,label,id='',extra='') => `<button class="ghost small" data-family-budget-action="${action}" data-id="${esc(id)}" ${extra}>${esc(label)}</button>`;
const control = (row,column,value,{disabled=false,type='text',label=column}={}) => `<input type="${type}" data-family-budget-field="${column}" data-id="${esc(row.id)}"
  value="${esc(value??'')}" aria-label="${esc(`${row.title}: ${label}`)}"${disabled?' disabled':''}${['monthly_amount','percent_value','allocation','fact'].includes(column)?' inputmode="decimal" class="num"':''}>`;
const ruleValue = (r,date,percent) => !inSeason(date,r.season_from,r.season_to) ? 0 : percent ? Number(r.percent_value)||0 : expenseAmountOn(r,date,'monthly_amount');

function season(ctx,row) {
  if (!row.season_from&&!row.season_to) return ctx.canEdit?act('add-season','+ период действия',row.id):'';
  return `<div class="category-season-fields">
    ${field('Период действия с',control(row,'season_from',row.season_from,{disabled:!ctx.canEdit,label:'Период с'}))}
    ${field('По',control(row,'season_to',row.season_to,{disabled:!ctx.canEdit,label:'Период по'}))}
    ${ctx.canEdit?act('drop-season','Убрать период',row.id):''}
    <div class="small-note season-format-note">Формат ММ-ДД. Можно через Новый год: 12-01 — 03-20.</div>
  </div>`;
}

function seasonContext(ctx) {
  const rows=structuredClone(ctx.state.family.categories);
  return {...ctx,state:{...ctx.state,expenses:{expense_categories:rows}},store:{update(domain,mutate){
    const before=new Map(rows.map(r=>[r.id,JSON.stringify(r.amount_seasons??[])]));
    mutate({expense_categories:rows});
    const changed=rows.find(r=>JSON.stringify(r.amount_seasons??[])!==before.get(r.id));
    if(changed)ctx.store.familyCommand('category',{id:changed.id,amount_seasons:changed.amount_seasons}).catch(e=>ctx.notice('danger',e.message));
  }}};
}

export function familyCategories(ctx) {
  const cats=activeCategories(ctx), date=yearMonth(ctx)+'-15';
  const rows=cats.filter(c=>!c.parent_id).map(c=>{
    const items=cats.filter(i=>i.parent_id===c.id), percent=c.mode==='percent_month', open=ctx.ui.open.has(`family-cat:${c.id}`);
    const value=items.length ? items.reduce((s,i)=>s+ruleValue(i,date,percent),0)*(inSeason(date,c.season_from,c.season_to)?1:0) : ruleValue(c,date,percent);
    const valueField=(row,disabled=false)=>field(percent?'Процент за месяц, %':'Основная сумма в месяц',control(row,percent?'percent_value':'monthly_amount',row.id===c.id&&items.length?value:row[percent?'percent_value':'monthly_amount'],
      {disabled:disabled||!ctx.canEdit,label:percent?'Процент за месяц':'Сумма в месяц'}), row.id===c.id&&items.length?'Складывается из подкатегорий с учётом их периода действия.':percent?'От всех полученных и ожидаемых взносов месяца.':'');
    return `<section class="card category-card" data-section="family-cat:${esc(c.id)}"><h2 class="category-heading">
      <button class="category-head" data-toggle="family-cat:${esc(c.id)}" aria-expanded="${open}" aria-controls="family-category-${esc(c.id)}">
        <span class="chev${open?' open':''}" aria-hidden="true">▸</span><span class="category-caption"><span class="category-name">${esc(c.title)}</span>
        <span class="category-meta">${items.length?`${items.length} ${ctx.fmt.plural(items.length,{one:'подкатегория',few:'подкатегории',many:'подкатегорий'})} · `:''}${percent?'процент от взносов месяца':'фиксированная сумма в месяц'}</span></span>
        <span class="category-amount num">${esc(percent?ctx.fmt.percent(value,1):ctx.fmt.money(value))}<span class="category-meta">${percent?'от взносов месяца':'в месяц'}</span></span>
      </button></h2><div id="family-category-${esc(c.id)}"${open?'':' hidden'}>${open?`<div class="category-editor">
      <div class="category-settings"><h3>Настройки категории</h3>
      <div class="grid cols-2">${field('Название',control(c,'title',c.title,{disabled:!ctx.canEdit,label:'Название категории'}))}
        ${field('Как считать',`<select data-family-budget-field="mode" data-id="${esc(c.id)}" aria-label="Способ расчёта ${esc(c.title)}"${!ctx.canEdit?' disabled':''}>
          <option value="fixed_month"${percent?'':' selected'}>Фиксированная сумма в месяц</option><option value="percent_month"${percent?' selected':''}>Фиксированный процент в месяц</option></select>`)}
        ${valueField(c,items.length>0)}</div><div class="category-season">${season(ctx,c)}</div>
        ${!percent&&!items.length?amountSeasons(ctx,'expense_categories',c):''}
        </div>
        <div class="category-items"><div class="category-items-title"><h3>Подкатегории${items.length?` · ${items.length}`:''}</h3>
          ${ctx.canEdit?act('add-item','+ подкатегория',c.id):''}</div>
          ${items.map(i=>`<div class="category-item" data-scroll-row="${esc(i.id)}"><div class="category-item-main">
            ${field('Подкатегория',control(i,'title',i.title,{disabled:!ctx.canEdit,label:'Название подкатегории'}))}${valueField(i)}
            <div class="category-item-actions">${ctx.canEdit?act('delete-category','✕',i.id):''}</div></div>
            ${season(ctx,i)}${!percent?amountSeasons(ctx,'expense_categories',i):''}</div>`).join('')}
        </div>${ctx.canEdit?`<div class="category-delete">${act('delete-category','Удалить категорию',c.id)}</div>`:''}
      </div>`:''}</div></section>`;
  });
  return `<div class="category-toolbar"><div><h2>Категории</h2><div class="small-note">Месячные правила распределения семейных взносов. Прошедшие распределения сохраняются.</div></div>
    ${ctx.canEdit?act('add-category','+ категория'):''}</div><div class="category-list">${rows.join('')||'<div class="card muted">Категорий пока нет.</div>'}</div>`;
}

export function familyOverview(ctx,{memberTag}) {
  const f=ctx.state.family,b=familyYearBudget(f,ctx.year), money=v=>esc(ctx.fmt.money(v));
  const stat=(label,value)=>`<div class="card stat"><div class="v">${money(value)}</div><div class="l">${label}</div></div>`;
  const members=f.members.filter(m=>m.active||f.contributions.some(c=>c.member_id===m.id&&c.pay_date.startsWith(String(ctx.year))));
  const memberRows=members.map(m=>{
    const list=f.contributions.filter(c=>c.member_id===m.id&&c.pay_date.startsWith(String(ctx.year)));
    const sum=status=>list.filter(c=>c.status===status).reduce((s,c)=>s+Number(c.amount),0);
    return `<tr><td>${memberTag(m)}</td><td class="num">${money(sum('posted'))}</td><td class="num">${money(sum('forecast'))}</td><td class="num"><b>${money(sum('posted')+sum('forecast'))}</b></td></tr>`;
  });
  const months=Array.from({length:12},(_,i)=>`${ctx.year}-${String(i+1).padStart(2,'0')}`);
  const rows=months.map(month=>{const v=familyBudget(f,month);return `<tr><td>${esc(ctx.fmt.month(month,{withYear:false}))}</td>
    <td class="num">${money(v.received)}</td><td class="num">${money(v.future)}</td><td class="num">${money(v.expected)}</td>
    <td class="num">${money(v.planned)}</td><td class="num${v.forecastBalance<0?' danger-text':''}">${money(v.forecastBalance)}</td></tr>`;});
  return `<h2>${ctx.year} год</h2><div class="grid cols-3">${stat('Получено за год',b.received)}${stat('Ожидается за год',b.future)}${stat('Расходы по плану за год',b.planned)}</div>
    ${card({title:'Взносы участников за год',body:table({head:['Участник','Получено','Ожидается','Всего за год'],rows:memberRows})})}
    ${card({title:'Бюджет по месяцам',body:table({head:['Месяц','Получено','Ожидается','Всего взносов','План расходов','Остаток'],rows,
      foot:`<tr><td><b>Итого за год</b></td><td class="num">${money(b.received)}</td><td class="num">${money(b.future)}</td><td class="num">${money(b.expected)}</td><td class="num">${money(b.planned)}</td><td class="num${b.forecastBalance<0?' danger-text':''}"><b>${money(b.forecastBalance)}</b></td></tr>`})})}
    ${b.unassigned>0?`<div class="info-box">${money(b.unassigned)} плана пока не распределено: в соответствующих месяцах нет подходящих будущих взносов.</div>`:''}`;
}

function allocationTable(ctx,c,row) {
  const editable=ctx.canEdit&&ctx.state.family.members.some(m=>m.id===c.member_id&&m.is_self&&m.active)
    &&!row.locked&&c.status!=='posted'&&c.pay_date>ctx.today;
  const groups=new Map();
  for(const item of row.allocations){const id=item.parent_id||item.category_id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(item);}
  const rows=[];
  for(const list of groups.values()){
    if(list.some(i=>i.parent_id)) rows.push(`<tr><td><b>${esc(list[0].parent_title)}</b></td><td class="num"><b>${esc(ctx.fmt.money(list.reduce((s,i)=>s+Number(i.amount),0)))}</b></td></tr>`);
    for(const i of list) rows.push(`<tr${i.parent_id?' class="fact-item"':''}><td>${esc(i.title)}</td><td class="num">${editable?`<input class="num${i.manual?' own':''}" inputmode="decimal"
      data-family-budget-field="allocation" data-member="${esc(c.member_id)}" data-period="${esc(c.period_id)}" data-id="${esc(i.category_id)}" value="${esc(i.amount)}"
      aria-label="${esc(`${i.title}, взнос ${ctx.fmt.date(c.pay_date)}`)}" style="max-width:150px;text-align:right;">`:esc(ctx.fmt.money(i.amount))}</td></tr>`);
  }
  return card({title:'Расходы по категориям',actions:editable?act('reset-allocations','Подставить по шаблону','',`data-member="${esc(c.member_id)}" data-period="${esc(c.period_id)}"`):'',
    body:table({head:['Категория / подкатегория','Сумма'],rows:rows.length?rows:['<tr><td colspan="2" class="muted">Для этого взноса категории не заданы.</td></tr>'],foot:`<tr><td><b>Итого</b></td><td class="num"><b>${esc(ctx.fmt.money(row.expenses))}</b></td></tr>`})});
}

export function familyIncomes(ctx,{memberTag,contributionControl}) {
  const f=ctx.state.family,filter=ctx.ui.draft.familyIncomeMember||'all', self=f.members.find(m=>m.is_self&&m.active);
  const members=new Map(f.members.map(m=>[m.id,m]));
  let list=f.contributions.filter(c=>c.pay_date.startsWith(String(ctx.year))).sort((a,b)=>a.pay_date.localeCompare(b.pay_date)||a.member_id.localeCompare(b.member_id)||a.period_id.localeCompare(b.period_id));
  if(filter!=='all')list=list.filter(c=>c.member_id===(filter==='mine'?self?.id:filter));
  const filters=`<div class="row wrap family-income-filters">${field('Показать взносы',`<select data-family-budget-field="member-filter" aria-label="Фильтр участников">
    <option value="all"${filter==='all'?' selected':''}>Всех участников</option><option value="mine"${filter==='mine'?' selected':''}>Мои взносы</option>
    ${f.members.map(m=>`<option value="${esc(m.id)}"${filter===m.id?' selected':''}>${esc(m.nickname||m.email||'Участник')}${m.active?'':' · вышел'}</option>`).join('')}</select>`)}</div>`;
  const past=list.filter(c=>c.pay_date<=ctx.today), latestByMember=new Map();
  for(const c of past)latestByMember.set(c.member_id,c);
  const recent=new Set([...latestByMember.values()].map(c=>c.id));
  const hiddenPast=past.filter(c=>!recent.has(c.id));
  const visiblePast=ctx.ui.open.has('past')?past:past.filter(c=>recent.has(c.id));
  const show=new Set(visiblePast.map(c=>c.id));
  const cards=list.filter(c=>c.pay_date>ctx.today||show.has(c.id)).map(c=>{
    const row=budgetRow(ctx,c),key=`family-income:${c.member_id}:${c.period_id}`,open=ctx.ui.open.has(key),member=members.get(c.member_id),free=Number(c.amount)-Number(row.expenses);
    const colors=['blue','pink','purple','green','orange'],color=colors.includes(member?.color)?member.color:'blue';
    return `<section class="period-card family-income-card family-${color}${open?' open':''}${c.pay_date<=ctx.today?' past':''}"${ctx.ui.open.has('past')&&c.id===hiddenPast.at(-1)?.id?' data-past-anchor tabindex="-1"':''}>
      <button class="period-head family-income-head" data-toggle="${esc(key)}" aria-expanded="${open}" aria-controls="family-income-${esc(c.id)}">
        <span class="period-date"><b>${esc(ctx.fmt.date(c.pay_date))}</b><span class="small-note">Семейный взнос</span></span>
        <span class="row wrap period-pills">${memberTag(member)}${c.status==='posted'?pill('🔒 получено'):c.pay_date<=ctx.today?pill('ожидает проведения'):''}${free<0?pill('дефицит','danger'):''}</span>
        <span class="period-sums"><span class="num">${esc(ctx.fmt.money(c.amount))}</span><span class="num muted">−${esc(ctx.fmt.money(row.expenses))}</span><span class="num"><b>${esc(ctx.fmt.money(free))}</b></span></span><span class="chev">›</span>
      </button>${open?`<div class="period-body" id="family-income-${esc(c.id)}"><div class="grid cols-2">
        ${field('Участник',memberTag(member))}${field('Сумма взноса',contributionControl(ctx,c))}</div>
        ${c.arrears_amount>0?`<p class="small-note">В том числе погашение недобора: ${esc(ctx.fmt.money(c.arrears_amount))}</p>`:''}
        ${allocationTable(ctx,c,row)}</div>`:''}</section>`;
  });
  return `${filters}${hiddenPast.length?`<button class="past-toggle" data-toggle="past">${ctx.ui.open.has('past')?'Скрыть предыдущие взносы':`Показать предыдущие взносы (${hiddenPast.length})`}</button>`:''}
    ${cards.join('')||'<div class="card muted">Взносов за этот год с выбранным фильтром нет.</div>'}`;
}

export function familyFacts(ctx) {
  const f=ctx.state.family,month=monthOf(ctx),b=familyBudget(f,month),money=v=>esc(ctx.fmt.money(v)),plans=new Map();
  for(const r of f.budget?.rows??[])if(r.pay_date.startsWith(month))for(const a of r.allocations)plans.set(a.category_id,(plans.get(a.category_id)||0)+Number(a.amount));
  for(const t of b.targets??[])plans.set(t.category_id,Math.max(plans.get(t.category_id)||0,Number(t.target)));
  const fact=id=>f.expense_facts.find(r=>r.category_id===id&&r.month===month)?.amount;
  const monthTabs=`<div class="month-tabs">${Array.from({length:12},(_,i)=>`${ctx.year}-${String(i+1).padStart(2,'0')}`).map(m=>`<button class="${m===month?'active':''}" data-family-budget-action="fact-month" data-id="${m}">${esc(ctx.fmt.month(m,{withYear:false}))}</button>`).join('')}</div>`;
  const visible=new Set(f.categories.filter(c=>plans.has(c.id)||fact(c.id)!=null).map(c=>c.id));
  for(const c of f.categories)if(visible.has(c.id)&&c.parent_id)visible.add(c.parent_id);
  const categories=f.categories.filter(c=>!c.archived||visible.has(c.id));
  const rows=[];
  const leaf=(c,label=c.title)=>`<tr${c.parent_id?' class="fact-item"':''}><td>${esc(label)}</td><td class="num muted">${money(plans.get(c.id)||0)}</td>
    <td class="num">${control(c,'fact',fact(c.id),{disabled:!ctx.canEdit,label:`Факт за ${month}`})}</td><td class="num">${fact(c.id)==null?'':money(Number(fact(c.id))-(plans.get(c.id)||0))}</td></tr>`;
  for(const c of categories.filter(c=>!c.parent_id)){
    const items=categories.filter(i=>i.parent_id===c.id&&(inSeasonMonth(month,i.season_from,i.season_to)||visible.has(i.id)));
    if(!inSeasonMonth(month,c.season_from,c.season_to)&&!visible.has(c.id))continue;
    if(!items.length)rows.push(leaf(c));else{
      const group=[c,...items],plan=group.reduce((s,i)=>s+(plans.get(i.id)||0),0),actual=group.reduce((s,i)=>s+Number(fact(i.id)||0),0);
      rows.push(`<tr><td><b>${esc(c.title)}</b></td><td class="num">${money(plan)}</td><td class="num">${money(actual)}</td><td class="num">${money(actual-plan)}</td></tr>`);
      if((plans.get(c.id)||0)>0||fact(c.id)!=null)rows.push(leaf(c,'Без подкатегории'));
      rows.push(...items.map(i=>leaf(i)));
    }
  }
  return `${monthTabs}${card({title:`Расходы за ${ctx.fmt.month(month)}`,body:table({head:['Категория / подкатегория','План','Факт','Отклонение'],rows:rows.length?rows:['<tr><td colspan="4" class="muted">Категорий нет.</td></tr>'],
    foot:`<tr><td><b>Итого</b></td><td class="num">${money(b.planned)}</td><td class="num">${money(b.actual)}</td><td class="num">${money(b.deviation)}</td></tr>`})})}`;
}

export function familyBudgetChange(ev,ctx) {
  if(ctx.state.account?.plan_kind!=='family')return false;
  if(amountSeasonChange(ev,ctx))return true;
  const el=ev.target.closest('[data-family-budget-field]');if(!el)return false;
  const column=el.dataset.familyBudgetField;
  if(column==='member-filter'){ctx.ui.draft.familyIncomeMember=el.value;return 'render';}
  if(!ctx.canEdit)return true;
  const run=async()=>{
    if(column==='allocation'){
      if(!ctx.state.family.members.some(m=>m.id===el.dataset.member&&m.is_self&&m.active))throw new Error('Можно изменять только распределение своих взносов');
      const amount=el.value.trim()===''?null:ctx.fmt.parseMoney(el.value);
      if(el.value.trim()&&(!Number.isFinite(amount)||amount===null||amount<0))throw new Error('Введите неотрицательную сумму');
      await ctx.store.familyCommand('allocation',{member_id:el.dataset.member,period_id:el.dataset.period,category_id:el.dataset.id,amount});
      return;
    }
    if(column==='fact'){
      const amount=el.value.trim()===''?null:ctx.fmt.parseMoney(el.value);
      if(el.value.trim()&&(!Number.isFinite(amount)||amount<0))throw new Error('Введите неотрицательную сумму');
      await ctx.store.familyCommand('fact',{category_id:el.dataset.id,month:monthOf(ctx),amount});return;
    }
    let value=el.value;
    if(['monthly_amount','percent_value'].includes(column)){
      value=column==='percent_value'?ctx.fmt.parseNumber(value):ctx.fmt.parseMoney(value);
      if(value===null||value<0||(column==='percent_value'&&value>100))throw new Error(column==='percent_value'?'Процент должен быть от 0 до 100':'Введите неотрицательную сумму');
    }
    await ctx.store.familyCommand('category',{id:el.dataset.id,[column]:value});
  };
  run().catch(e=>ctx.notice('danger',e.message));return true;
}

export function familyBudgetHandle(ev,ctx) {
  if(ctx.state.account?.plan_kind!=='family')return false;
  if(amountSeasonHandle(ev,seasonContext(ctx)))return true;
  const el=ev.target.closest('[data-family-budget-action]');if(!el)return false;
  const op=el.dataset.familyBudgetAction,id=el.dataset.id;
  if(op==='fact-month'){ctx.ui.draft.familyFactMonth=id;return true;}
  if(!ctx.canEdit)return true;
  const run=async()=>{
    if(op==='add-category'||op==='add-item'){
      const row={id:uid('family-cat'),title:op==='add-item'?'Новая подкатегория':'Новая категория',parent_id:op==='add-item'?id:null,sort_order:ctx.state.family.categories.length};
      ctx.ui.open.add(`family-cat:${row.parent_id||row.id}`);ctx.ui.scrollTarget=row.parent_id?{row:row.id}:{section:`family-cat:${row.id}`};
      await ctx.store.familyCommand('category',row);return;
    }
    if(op==='delete-category'){
      if(!confirm('Удалить категорию из будущего распределения? Прошедшие распределения и факт сохранятся.'))return;
      await ctx.store.familyCommand('delete_category',{id});return;
    }
    if(op==='add-season'||op==='drop-season'){
      await ctx.store.familyCommand('category',{id,season_from:op==='add-season'?'01-01':null,season_to:op==='add-season'?'12-31':null});return;
    }
    if(op==='reset-allocations'){
      if(!ctx.state.family.members.some(m=>m.id===el.dataset.member&&m.is_self&&m.active))throw new Error('Можно изменять только распределение своих взносов');
      await ctx.store.familyCommand('reset_allocations',{member_id:el.dataset.member,period_id:el.dataset.period});
    }
  };
  run().catch(e=>ctx.notice('danger',e.message));return true;
}
