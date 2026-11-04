import { esc, card, button, table } from './dom.js';
import { localPlanData, copy, changeDetails } from '../core/plan-history.js';
import { applyScenario } from '../engine/scenarios.js';
import { comparePlans, forecastChanges } from '../engine/plan-compare.js';

export const code='planning';
export const title=()=> 'Сценарии и история';
export const hasYears=true;
const TYPES={expense:'Расходы в месяц',income:'Доход в месяц',purchase:'Разовая покупка',fx:'Изменение курса, %'};
const date=(ctx,value)=>value==='pre'?'уже накоплено':value?ctx.fmt.date(value):'не достигается';

export function comparisonHtml(ctx,comparison){
  if(!comparison)return '<p class="small-note">Влияние на прогноз пока недоступно: проверьте данные плана.</p>';
  const changes=forecastChanges(comparison,ctx.year);
  if(!changes.length)return '<p class="small-note">Денежный прогноз и даты достижения целей не изменились.</p>';
  return table({head:['Что изменилось','Основной план','После изменения'],rows:changes.map(c=>`<tr><td>${esc(c.title)}</td>
    <td>${esc(c.kind==='money'?ctx.fmt.money(c.before,c.currency):date(ctx,c.before))}</td>
    <td>${esc(c.kind==='money'?ctx.fmt.money(c.after,c.currency):date(ctx,c.after))}${c.kind==='money'?` <span class="small-note">(${esc(ctx.fmt.money(c.delta,c.currency,{sign:true}))})</span>`:''}</td></tr>`)});
}

export function changeExplanation(ctx){
  const entry=ctx.store.lastHistory?.();
  if(!entry||ctx.ui.explanationDismissed===entry.id||ctx.state.account?.plan_kind==='family')return '';
  const year=forecastChanges(entry.comparison,ctx.year).some(c=>c.kind==='money')?ctx.year:
    Object.keys(entry.comparison?.after.years??{}).find(y=>forecastChanges(entry.comparison,y).some(c=>c.kind==='money'))??ctx.year;
  const changes=forecastChanges(entry.comparison,year),money=changes.filter(c=>c.kind==='money');
  const lines=money.slice(0,4).map(c=>`${c.title}: ${ctx.fmt.money(c.delta,c.currency,{sign:true})} за ${year} год`);
  const dates=changes.filter(c=>c.kind==='date');
  if(dates.length)lines.push(`Изменились сроки целей: ${dates.length}.`);
  return `<aside class="info-box forecast-explanation" aria-label="Почему изменился прогноз"><div class="row between wrap"><b>Почему изменился прогноз</b>
    <button class="ghost small" data-explanation-close="${esc(entry.id)}" aria-label="Скрыть объяснение">✕</button></div>
    <p>${esc(entry.label)}</p><p>${esc(lines.join(' · ')||(entry.comparison?'Правка не изменила денежный прогноз.':'Влияние на прогноз пока недоступно: проверьте данные плана.'))}</p>
    <button class="ghost small" data-planning-view="history">Подробнее в истории</button></aside>`;
}

function draft(ctx){
  return ctx.ui.draft.planning??={view:'scenarios',items:localPlanData(ctx.state,'scenarios').read(),scenario:null,error:''};
}
const options=(values,selected)=>values.map(([value,label])=>`<option value="${esc(value)}"${value===selected?' selected':''}>${esc(label)}</option>`).join('');

function scenarios(ctx,d){
  const saved=d.items.map(s=>`<button class="ghost small" data-scenario-select="${esc(s.id)}">${esc(s.name)}</button>`).join('');
  let body=`<p>Проверьте изменения на копии текущего личного плана. Сравнение обновляется при правке сценария; основной план и его автосохранение не затрагиваются.</p>
    <div class="row wrap">${saved}<button class="primary small" data-scenario-new>+ Новый сценарий</button></div>`;
  const scenario=d.scenario;if(!scenario)return card({title:'А если…',body});
  body+=`<div class="scenario-editor"><label>Название сценария<input data-scenario-name value="${esc(scenario.name)}"></label>`;
  for(const [i,c] of scenario.adjustments.entries()){
    const targets=c.type==='fx'?ctx.cfg.list('currencies').filter(x=>x.code!==ctx.cfg.get('base_currency')).map(x=>[x.code,x.title]):
      [['','Дополнительные расходы'],...(ctx.state.expenses?.expense_categories??[]).map(x=>[x.id,x.title])];
    const field=(key,label,input)=>`<label>${label}${input}</label>`;
    const attr=key=>`data-scenario-field="${key}" data-scenario-index="${i}"`;
    body+=`<div class="scenario-adjustment">
      ${field('type','Что изменить',`<select ${attr('type')}>${options(Object.entries(TYPES),c.type)}</select>`)}
      ${['expense','fx'].includes(c.type)?field('target',c.type==='fx'?'Валюта':'Категория',`<select ${attr('target')}>${options(targets,c.target)}</select>`):''}
      ${field('amount',c.type==='fx'?'Изменение, %':`Изменение, ${esc(ctx.cfg.get('base_currency'))}${c.type==='purchase'?'':' в месяц'}`,`<input inputmode="decimal" ${attr('amount')} value="${esc(c.amount)}">`)}
      ${field('from',c.type==='purchase'?'Дата покупки':'С даты',`<input type="date" ${attr('from')} value="${esc(c.from)}">`)}
      ${c.type!=='purchase'&&c.type!=='fx'?field('to','По дату (необязательно)',`<input type="date" ${attr('to')} value="${esc(c.to)}">`):''}
      <button class="ghost small" data-scenario-remove="${i}" aria-label="Убрать изменение">✕</button></div>`;
  }
  body+=`<p class="small-note">Для снижения введите отрицательную сумму. Изменения дохода и расходов распределяются между незакреплёнными выплатами выбранного месяца; покупка относится к последней доступной выплате до её даты. Зафиксированные выплаты сохраняются. Валютный сценарий меняет курс прогноза целиком.</p>
    <div class="row wrap"><button class="ghost small" data-scenario-add>+ Ещё изменение</button><button class="primary small" data-scenario-save>Сохранить сценарий</button>
    <button class="ghost small" data-scenario-delete>Удалить сценарий</button></div></div>`;
  try{
    const result=applyScenario(ctx.state,scenario,ctx.today),comparison=comparePlans(ctx.state,result.state,ctx.today);
    body+=`<h3>Сравнение за ${ctx.year} год</h3>${result.notes.map(n=>`<p class="info-box">${esc(n)}</p>`).join('')}${comparisonHtml(ctx,comparison)}`;
  }catch(error){body+=`<p class="info-box">${esc(error.message)}</p>`;}
  return card({title:'А если…',body});
}

function historyView(ctx){
  const entries=ctx.store.history?.()??[],latest=entries.find(e=>!e.undone);
  return card({title:'История изменений',body:`<p>Последние 50 действий в этом браузере. Связанные изменения сохраняются вместе. Отмена доступна по очереди, начиная с последнего действия, и отправляется в основной план.</p>
    ${ctx.store.historyBusy?'<p role="status">Выполняется отмена действия…</p>':''}
    ${ctx.store.historyPersistent===false?'<p class="info-box">Хранилище браузера недоступно или заполнено. Новые записи истории доступны только до закрытия страницы.</p>':''}
    ${entries.length?entries.map(e=>`<article class="history-entry"><div class="row between wrap"><div><b>${esc(e.label)}</b><p class="small-note">${esc(new Date(e.at).toLocaleString('ru-RU'))}${e.undone?' · отменено':''}</p></div>
      ${ctx.canEdit&&!e.undone?`<button class="ghost small" data-history-undo="${esc(e.id)}"${latest?.id!==e.id||ctx.store.historyBusy?' disabled':''}>Отменить действие</button>`:''}</div>
      <details${ctx.ui.open.has(`history:${e.id}`)?' open':''}><summary data-history-details="${esc(e.id)}">Что изменилось и как повлияло на прогноз</summary>
      <ul>${changeDetails(e).map(c=>`<li>${esc(c.title)}: ${esc(value(c.before))} → ${esc(value(c.after))}</li>`).join('')}</ul>
      ${comparisonHtml(ctx,e.comparison)}</details></article>`).join(''):'<p class="small-note">История пока пуста. Изменения начнут появляться после правок личного плана.</p>'}`});
}
const value=x=>x===null||x===undefined?'нет':typeof x==='object'?JSON.stringify(x):String(x);

export function render(ctx){
  const d=draft(ctx);
  return `<div class="row wrap planning-tabs"><button class="${d.view==='scenarios'?'active':''}" data-planning-view="scenarios">А если…</button><button class="${d.view==='history'?'active':''}" data-planning-view="history">История изменений</button></div>
    <p class="small-note">Сценарии и история хранятся в этом браузере отдельно для вашего пользователя и выбранного плана. На других устройствах они не появляются.</p>
    ${d.error?`<p class="info-box">${esc(d.error)}</p>`:''}${d.view==='history'?historyView(ctx):scenarios(ctx,d)}`;
}

export function handleChange(ev,ctx){
  const name=ev.target.closest('[data-scenario-name]'),field=ev.target.closest('[data-scenario-field]');
  if(!name&&!field)return false;
  const d=draft(ctx);if(!d.scenario)return true;
  if(name)d.scenario.name=name.value;
  else{
    const row=d.scenario.adjustments[Number(field.dataset.scenarioIndex)],key=field.dataset.scenarioField;
    if(!row)return true;
    row[key]=key==='amount'?ctx.fmt.parseNumber(field.value):field.value;
    if(key==='type')row.target=row.type==='fx'?'USD':'';
  }
  return true;
}

export function handle(ev,ctx){
  const target=ev.target,d=draft(ctx),find=key=>target.closest(`[data-${key}]`);
  const details=find('history-details');if(details){ev.preventDefault?.();const key=`history:${details.dataset.historyDetails}`;if(ctx.ui.open.has(key))ctx.ui.open.delete(key);else ctx.ui.open.add(key);return true;}
  const view=find('planning-view');if(view){d.view=view.dataset.planningView;d.error='';ctx.ui.tab=code;return true;}
  const close=find('explanation-close');if(close){ctx.ui.explanationDismissed=close.dataset.explanationClose;return true;}
  if(find('scenario-new')){d.scenario={id:crypto.randomUUID(),name:'Новый сценарий',adjustments:[{type:'expense',target:'',amount:500,from:ctx.today,to:''}]};return true;}
  const selected=find('scenario-select');if(selected){d.scenario=copy(d.items.find(s=>s.id===selected.dataset.scenarioSelect));return true;}
  if(find('scenario-add')){d.scenario.adjustments.push({type:'expense',target:'',amount:500,from:ctx.today,to:''});return true;}
  const remove=find('scenario-remove');if(remove){d.scenario.adjustments.splice(Number(remove.dataset.scenarioRemove),1);return true;}
  if(find('scenario-save')){
    try{applyScenario(ctx.state,d.scenario,ctx.today);if(!d.scenario.name.trim())throw new Error('Укажите название сценария');
      if(!d.items.some(s=>s.id===d.scenario.id)&&d.items.length>=20)throw new Error('Можно сохранить до 20 сценариев. Удалите ненужный сценарий перед добавлением нового');
      d.items=[copy(d.scenario),...d.items.filter(s=>s.id!==d.scenario.id)].slice(0,20);
      d.error=localPlanData(ctx.state,'scenarios').write(d.items)?'Сценарий сохранён в этом браузере.':'Хранилище недоступно. Сценарий останется только до закрытия страницы.';
    }catch(error){d.error=error.message;}return true;
  }
  if(find('scenario-delete')){d.items=d.items.filter(s=>s.id!==d.scenario.id);localPlanData(ctx.state,'scenarios').write(d.items);d.scenario=null;return true;}
  const undo=find('history-undo');if(undo){ctx.store.undoHistory(undo.dataset.historyUndo).catch(e=>ctx.notice('danger',e.message));return true;}
  return false;
}
