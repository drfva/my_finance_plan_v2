import {esc,table} from './dom.js';
import {forecastChanges} from '../engine/plan-compare.js';

const date=(ctx,value)=>value==='pre'?'уже накоплено':value?ctx.fmt.date(value):'не достигается';
export function comparisonHtml(ctx,comparison){
  if(!comparison)return '<p class="small-note">Влияние на прогноз пока недоступно: проверьте данные плана.</p>';
  const changes=forecastChanges(comparison,ctx.year);
  if(!changes.length)return '<p class="small-note">Денежный прогноз и даты достижения целей не изменились.</p>';
  return table({head:['Что изменилось','Было','Стало'],rows:changes.map(c=>`<tr><td>${esc(c.title)}</td>
    <td>${esc(c.kind==='money'?ctx.fmt.money(c.before,c.currency):date(ctx,c.before))}</td>
    <td>${esc(c.kind==='money'?ctx.fmt.money(c.after,c.currency):date(ctx,c.after))}${c.kind==='money'?` <span class="small-note">(${esc(ctx.fmt.money(c.delta,c.currency,{sign:true}))})</span>`:''}</td></tr>`)});
}

export function renderChangeToast(ctx,entry){
  if(!entry||ctx.state.account?.plan_kind==='family')return '';
  const year=forecastChanges(entry.comparison,ctx.year).some(c=>c.kind==='money')?ctx.year:
    Object.keys(entry.comparison?.after.years??{}).find(y=>forecastChanges(entry.comparison,y).some(c=>c.kind==='money'))??ctx.year;
  const changes=forecastChanges(entry.comparison,year);
  const lines=changes.filter(c=>c.kind==='money').slice(0,3).map(c=>`${c.title}: ${ctx.fmt.money(c.delta,c.currency,{sign:true})} за ${year} год`);
  const dates=changes.filter(c=>c.kind==='date');
  if(dates.length)lines.push(`Изменились сроки целей: ${dates.length}.`);
  return `<aside class="change-toast" role="status" aria-live="polite" aria-label="Изменения прогноза">
    <button class="change-toast-content" data-open-plan-history="${year}"><strong>${esc(entry.label)}</strong>
      <span>${esc(lines.join(' · ')||(entry.comparison?'Денежный прогноз не изменился.':'Влияние на прогноз пока недоступно.'))}</span>
      <small>Открыть историю изменений</small></button>
    <button class="ghost small change-toast-close" data-dismiss-change aria-label="Закрыть уведомление">✕</button></aside>`;
}

export function createChangeToast({onChange=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let entry=null,timer=null;
  function dismiss(){if(timer!==null)clearTimer(timer);timer=null;entry=null;onChange(null);}
  return {get entry(){return entry;},dismiss,show(next){
    if(timer!==null)clearTimer(timer);
    entry=next;timer=setTimer(dismiss,3000);onChange(entry);
  }};
}
