import {esc,input,button,delButton,pill,field} from './dom.js';
import {goalTotal} from '../engine/savings.js';
import {goalBalanceAt,goalProgressAt,goalMilestoneAt} from '../engine/allocation.js';
import {goalTimeline,stageTimelineDate} from './goal-timeline.js';

export const GOAL_VIEWS=[['stages','Этапы'],['movements','Движения'],['parameters','Параметры'],['repeats','Повторения']];
export function goalView(ctx,id){return ctx.ui.goalViews?.[id]??((ctx.state.savings?.goal_milestones??[]).some(m=>m.goal_id===id)?'stages':'parameters');}
export function setGoalView(ctx,id,view){(ctx.ui.goalViews??={})[id]=view;}

export function renderGoalCard(ctx,g,options,helpers){
 const {state,fmt,canEdit,sim,ui}=ctx,{extraFields='',canDelete=true,showCycles=true,showPriority=true}=options;
 const all=sim.milestonesOf(g),own=(state.savings?.goal_milestones??[]).filter(m=>m.goal_id===g.id),txs=(state.savings?.goal_transactions??[]).filter(t=>t.goal_id===g.id).sort((a,b)=>b.date.localeCompare(a.date));
 const total=goalTotal(g,state.savings?.goal_milestones??[]),balance=goalBalanceAt(sim,g,state.savings?.goal_transactions??[],ctx.today),progress=goalProgressAt(sim,g,ctx.today);
 const pct=total>0?Math.max(0,Math.min(100,progress/total*100)):0,view=goalView(ctx,g.id),menu=ui.open.has(`goal-menu:${g.id}`);
 const status=(m)=>{const s=helpers.milestoneStatus(ctx,g,m);return pill(s.label,`${s.cls||'forecast'} goal-forecast${s.beyondPlan&&!m.deadline?' beyond':''}`);};
 const summary=helpers.goalSummary(ctx,g),currency=ctx.cfg.currency(g.currency_code)?.symbol||g.currency_code;
 const main=all[0];
 const menuHtml=`<div class="goal-more-menu" aria-label="Действия с копилкой ${esc(g.title)}">
   ${canEdit?button({action:'goal-close',value:g.id,label:g.completed?'Вернуть в работу':'Закрыть цель',cls:'ghost small'}):''}
   ${canEdit&&['bucket','reserve'].includes(g.kind_code)?button({action:'goal-toggle-overview',value:g.id,label:g.hidden_overview?'Вернуть в Обзор':'Скрыть с Обзора',cls:'ghost small'}):''}
   ${button({action:'ledger-open',value:g.id,label:'История баланса',cls:'ghost small'})}
   ${canEdit&&showPriority&&!g.completed&&!g.archived?`<div class="goal-priority-controls"><span>Приоритет ${g.priority??'—'}</span>${button({action:'goal-move',value:`${g.id}:up`,label:'↑',title:'Повысить приоритет',cls:'ghost small'})}${button({action:'goal-move',value:`${g.id}:down`,label:'↓',title:'Понизить приоритет',cls:'ghost small'})}</div>`:''}
   ${canEdit&&g.completed?button({action:'goal-archive',value:g.id,label:g.archived?'Вернуть из архива':'В архив',cls:'ghost small'}):''}
   ${canEdit&&g.completed&&balance>.5?button({action:'redistribute',value:g.id,label:'Раздать остаток другим целям',cls:'ghost small'}):''}
   ${canEdit&&canDelete?delButton({domain:'savings',table:'goals',key:{id:g.id},label:'Удалить копилку',cls:'ghost small danger-text',confirm:`Удалить «${g.title}» вместе с этапами, движениями и ручными суммами?`}):''}</div>`;
 function stageRow(m){
  const index=all.findIndex(x=>x.id===m.id),current=goalMilestoneAt(sim,g,index,ctx.today),open=ui.open.has(`goal-stage:${m.id}`),generated=m.source&&m.source!=='manual';
  return `<section class="goal-stage" data-scroll-row="${esc(m.id)}"><div class="goal-stage-head">
   ${input({edit:'savings|goal_milestones|title',key:{id:m.id},value:m.title,cls:'goal-stage-title',ariaLabel:`Название этапа ${m.title||'без названия'}`,disabled:!canEdit})}
   <span class="goal-stage-forecast">${status(m)}</span>
   <span class="goal-stage-amount">${input({edit:'savings|goal_milestones|target',key:{id:m.id},value:fmt.number(m.target),type:'money',cls:'goal-stage-value',ariaLabel:`Сумма этапа ${m.title||'без названия'}`,disabled:!canEdit})}<span>${esc(currency)}</span></span>
   <button class="ghost small goal-stage-toggle" data-goal-stage-toggle="${esc(m.id)}" aria-expanded="${open}" aria-controls="goal-stage-${esc(m.id)}" aria-label="${open?'Свернуть':'Раскрыть'} этап ${esc(m.title)}"><span aria-hidden="true">${open?'▴':'▾'}</span></button>
   <span class="goal-stage-balance">На счету: <b>${esc(fmt.money(current.balance,g.currency_code))}</b></span></div>
   ${open?`<div class="goal-stage-body" id="goal-stage-${esc(m.id)}"><div class="goal-stage-details">
    ${field('Срок',input({edit:'savings|goal_milestones|deadline',key:{id:m.id},value:m.deadline,type:'date',clearable:true,ariaLabel:`Срок этапа ${m.title}`,disabled:!canEdit}))}
    <div><span class="small-note">Осталось накопить</span><b class="goal-stage-need">${esc(fmt.money(current.need,g.currency_code))}</b></div></div>
    <div class="row wrap goal-stage-actions">${canEdit?button({action:'ms-spend',value:m.id,label:'Создать трату',cls:'ghost small'}):''}
    ${canEdit&&showCycles&&!generated?button({action:'make-cycle',value:`ms:${m.id}`,label:'Сделать периодической',cls:'ghost small'}):''}
    ${canEdit?delButton({domain:'savings',table:'goal_milestones',key:{id:m.id},confirm:'Удалить этап? Покупки, привязанные к этапу, сначала нужно перенести.',cls:'ghost small goal-stage-delete'}):''}</div>
    ${generated?`<p class="small-note">${m.source==='gift'?'Из праздника':'Из повторения'}${m.user_edited?' · своя правка':''}${canEdit&&m.user_edited?button({action:'edit-generated',value:`back:${m.id}`,label:'Вернуть к шаблону',cls:'ghost small'}):''}</p>`:''}</div>`:''}</section>`;
 }
 const movements=`<p class="small-note">На счету сейчас: <b>${esc(fmt.money(balance,g.currency_code))}</b></p>${goalTimeline(ctx,{key:`tx-hist:${g.id}`,items:txs,dateOf:t=>t.date,label:`Движения копилки ${g.title}`,pastLabel:'прошедшие движения',emptyNote:'Операций пока нет.',render:t=>{
   const other=state.savings.goals.find(x=>x.id===t.counterparty_id),stage=own.find(m=>m.id===t.milestone_id);
   const kind=t.kind==='deposit'?'Пополнение':t.kind==='transfer_out'?`Перевод в «${other?.title??'—'}»`:t.kind==='transfer_in'?`Перевод из «${other?.title??'—'}»`:t.purpose==='goal'?`На цель${stage?' · '+stage.title:''}`:'На другое';
   return `<div class="goal-movement${ui.lastGoalTransaction===t.id?' goal-movement-new':''}" data-scroll-row="${esc(t.id)}"><div><b>${esc(t.title||'Операция')}</b><p class="small-note">${esc(fmt.date(t.date))} · ${esc(kind)}${t.date>ctx.today?' · по плану':''}</p></div><span class="num">${t.kind==='spend'||t.kind==='transfer_out'?'−':'+'}${esc(fmt.money(t.amount,g.currency_code))}</span>${canEdit?`<div class="row">${button({action:'goal-op-edit',value:t.id,label:'Изменить',cls:'ghost small'})}${delButton({domain:'savings',table:'goal_transactions',key:{id:t.id},confirm:t.kind.startsWith('transfer')?'Удалить перевод в обеих копилках?':'Удалить операцию?',cls:'ghost small'})}</div>`:''}</div>`;
 }})}${canEdit?`<div class="goal-card-actions">${button({action:'goal-op-open',value:g.id,label:'+ Добавить операцию',cls:'primary small'})}</div>`:''}`;
 const quote=g.currency_code!==ctx.cfg.get('base_currency')?sim.savingsFx?.quoteOn(g.currency_code,ctx.today):null;
 const parameters=`<div class="grid cols-2 goal-parameters">${field('Валюта',helpers.currencyPicker(ctx,g))}${field('Начальный остаток',input({edit:'savings|goals|starting_balance',key:{id:g.id},value:g.starting_balance,type:'money',ariaLabel:'Начальный остаток',disabled:!canEdit}))}
  ${!own.length?`${field('Сколько накопить',input({edit:'savings|goals|target_amount',key:{id:g.id},value:g.target_amount,type:'money',ariaLabel:'Сумма копилки',disabled:!canEdit}))}${field('Срок',input({edit:'savings|goals|deadline',key:{id:g.id},value:g.deadline,type:'date',clearable:true,ariaLabel:'Срок копилки',disabled:!canEdit}))}`:''}</div>
  ${g.currency_code!==ctx.cfg.get('base_currency')?`<p class="small-note">${quote?`Курс для прогноза: 1 ${esc(g.currency_code)} = ${esc(fmt.number(quote.rate,4))} ${esc(ctx.cfg.get('base_currency'))} на ${esc(fmt.date(quote.date))}.`:'Нет курса валюты: автоматическое накопление и прогноз недоступны.'}${state.current_fx?.error?' Не удалось обновить курс; показаны сохранённые данные.':''}</p>`:''}${extraFields}`;
 const stageDates=new Map(all.map(m=>[m.id,stageTimelineDate(m,helpers.milestoneStatus(ctx,g,m))]));
 const stageBody=`${own.length?goalTimeline(ctx,{key:`ms-hist:${g.id}`,items:all,dateOf:m=>stageDates.get(m.id),render:stageRow,label:`Этапы копилки ${g.title}`,pastLabel:'пройденные этапы',emptyNote:'Этапов пока нет.'}):'<p class="small-note">Общая сумма и срок задаются в Параметрах.</p>'}${canEdit?`<div class="goal-card-actions">${button({action:'goal-stage-add',value:g.id,label:'+ Добавить этап',cls:'ghost small'})}</div>`:''}`;
 const repeatBody=showCycles?`${helpers.cyclesBlock(ctx,g)}${canEdit&&!own.length?button({action:'make-cycle',value:`goal:${g.id}`,label:'Сделать периодической',cls:'ghost small'}):''}`:'';
 return `<article class="card goal-card goal-card-compact${summary.late?' goal-late':''}" data-goal-card="${esc(g.id)}">
  <div class="goal-card-header"><input class="goal-title" data-edit="savings|goals|title" data-key='${esc(JSON.stringify({id:g.id}))}' value="${esc(g.title)}" placeholder="Название" aria-label="Название копилки ${esc(g.title)}"${canEdit?'':' disabled'}>
   ${!own.length&&total>0?`<span class="goal-header-forecast">${status(main)}</span>`:''}<button class="ghost small goal-more" data-goal-menu-toggle="${esc(g.id)}" aria-expanded="${menu}" aria-label="Действия с копилкой ${esc(g.title)}">⋯</button>${menu?menuHtml:''}</div>
  ${g.completed||g.archived||g.hidden_overview?`<p class="small-note">${[g.completed?'Закрыта':'',g.archived?'В архиве':'',g.hidden_overview?'Скрыта с Обзора':''].filter(Boolean).join(' · ')}</p>`:''}
  ${total>0?`<div class="progress" role="progressbar" aria-label="Общий прогресс на сегодня" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div><div class="row between small-note"><span>${esc(fmt.money(progress,g.currency_code))} из ${esc(fmt.money(total,g.currency_code))}</span><span>${Math.round(pct)}% · на сегодня</span></div>`:'<p class="small-note">Задайте сумму в Параметрах или добавьте этап.</p>'}
  <div class="goal-card-tabs" role="tablist" aria-label="Разделы копилки ${esc(g.title)}">${GOAL_VIEWS.filter(([code])=>showCycles||code!=='repeats').map(([code,label])=>`<button class="ghost small" role="tab" id="goal-view-${esc(g.id)}-${code}" aria-controls="goal-body-${esc(g.id)}" aria-selected="${view===code}" data-goal-card-tab="${code}" data-goal-id="${esc(g.id)}">${label}</button>`).join('')}</div>
  <div id="goal-body-${esc(g.id)}" role="tabpanel" aria-labelledby="goal-view-${esc(g.id)}-${view}">${view==='stages'?stageBody:view==='movements'?movements:view==='parameters'?parameters:repeatBody}</div></article>`;
}
