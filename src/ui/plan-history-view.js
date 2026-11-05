import {esc,card} from './dom.js';
import {changeDetails} from '../core/plan-history.js';
import {comparisonHtml} from './plan-changes.js';

const value=x=>x===null||x===undefined?'нет':typeof x==='object'?JSON.stringify(x):String(x);

export function renderHistory(ctx,{embedded=false}={}){
  const entries=ctx.store.history?.()??[],latest=entries[0];
  const years=[...new Set([...(ctx.years??[ctx.year]),...entries.flatMap(e=>[
    ...Object.keys(e.comparison?.before.years??{}),...Object.keys(e.comparison?.after.years??{})])].map(Number))].filter(Number.isFinite).sort((a,b)=>a-b);
  const year=years.includes(ctx.ui.historyYear)?ctx.ui.historyYear:years.includes(ctx.year)?ctx.year:years.at(-1);
  const viewCtx={...ctx,year};
  const body=`<p>Последние 50 действий в этом браузере, отдельно для вашего пользователя и плана. Связанные изменения сохраняются вместе. Отмена доступна по очереди, начиная с последнего действия, и отправляется в основной план.</p>
    ${years.length>1?`<label class="history-year">Год сравнения<select data-history-year>${years.map(y=>`<option value="${y}"${y===year?' selected':''}>${y}</option>`).join('')}</select></label>`:''}
    ${ctx.store.historyBusy?'<p role="status">Выполняется отмена действия…</p>':''}
    ${ctx.store.historyPersistent===false?'<p class="info-box">Хранилище браузера недоступно или заполнено. Новые записи истории доступны только до закрытия страницы.</p>':''}
    ${entries.length?entries.map(e=>`<article class="history-entry"><div class="row between wrap"><div><b>${esc(e.label)}</b><p class="small-note">${esc(new Date(e.at).toLocaleString('ru-RU'))}</p></div>
      ${ctx.canEdit?`<button class="ghost small" data-history-undo="${esc(e.id)}"${latest?.id!==e.id||ctx.store.historyBusy?' disabled':''}>Отменить действие</button>`:''}</div>
      <details${ctx.ui.open.has(`history:${e.id}`)?' open':''}><summary data-history-details="${esc(e.id)}">Что изменилось и как повлияло на прогноз</summary>
      <ul>${changeDetails(e).map(c=>`<li>${esc(c.title)}: ${esc(value(c.before))} → ${esc(value(c.after))}</li>`).join('')}</ul>
      ${comparisonHtml(viewCtx,e.comparison)}</details></article>`).join(''):'<p class="small-note">История пока пуста. Изменения начнут появляться после правок личного плана.</p>'}`;
  return embedded?body:card({title:'История изменений',body});
}

export function handleHistoryChange(ev,ctx){
  const year=ev.target.closest('[data-history-year]');
  if(!year)return false;
  ctx.ui.historyYear=Number(year.value);return true;
}

export function handleHistory(ev,ctx){
  const open=ev.target.closest('[data-open-plan-history]');
  if(open){
    ctx.ui.tab='settings';ctx.ui.open.add('set:plan-history');
    ctx.ui.historyYear=Number(open.dataset.openPlanHistory)||ctx.year;
    ctx.ui.scrollTarget={section:'set:plan-history'};return true;
  }
  const details=ev.target.closest('[data-history-details]');
  if(details){ev.preventDefault?.();const key=`history:${details.dataset.historyDetails}`;
    if(ctx.ui.open.has(key))ctx.ui.open.delete(key);else ctx.ui.open.add(key);return true;}
  const undo=ev.target.closest('[data-history-undo]');
  if(undo){ctx.store.undoHistory(undo.dataset.historyUndo).catch(e=>ctx.notice('danger',e.message));return true;}
  return false;
}
