import {esc} from './dom.js';

const dated=value=>/^\d{4}-\d{2}-\d{2}$/.test(value??'');

// Срок остаётся датой этапа даже при более раннем или позднем накоплении.
export function stageTimelineDate(stage,status){
 return dated(stage.deadline)?stage.deadline:dated(status.done)?status.done:null;
}

export function goalTimeline(ctx,{key,items,dateOf,render,label,pastLabel,emptyNote}){
 const entries=items.map(item=>({item,date:dateOf(item)}));
 const past=entry=>Boolean(entry.date&&entry.date<ctx.today);
 const count=entries.filter(past).length,open=ctx.ui.open.has(key);
 // Сохранённая запись должна быть видна и при дате в прошлом, и без даты прогноза.
 const pending=entries.find(e=>e.item.id===ctx.ui.scrollTarget?.row);
 if(pending&&past(pending))ctx.ui.open.add(key);
 const expanded=open||Boolean(pending&&past(pending));
 const visible=entries.filter(e=>expanded||!past(e)).sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999'));
 const groups=new Map();
 for(const entry of visible){const year=entry.date?.slice(0,4)||'Без даты';if(!groups.has(year))groups.set(year,[]);groups.get(year).push(entry.item);}
 const scrolling=visible.length>3;
 const body=visible.length?[...groups].map(([year,list])=>`<div class="year-group"><div class="year-cap">${esc(year)}</div>${list.map(render).join('')}</div>`).join(''):`<p class="small-note">${esc(count?'Все записи в прошлом. Откройте их кнопкой выше.':emptyNote)}</p>`;
 return `${count?`<button class="ghost small goal-history-toggle" data-toggle="${esc(key)}" data-goal-history="${esc(key)}" aria-expanded="${expanded}" aria-controls="goal-timeline-${esc(key)}">${expanded?'Скрыть':'Показать'} ${esc(pastLabel)} (${count})</button>`:''}
  <div id="goal-timeline-${esc(key)}" class="goal-timeline${scrolling?' timeline-scroll':''}" data-goal-timeline="${esc(key)}"${scrolling?` tabindex="0" role="region" aria-label="${esc(label)}: прокручиваемый список"`:''}>${body}</div>${scrolling?'<p class="small-note goal-scroll-hint">Видны 3 записи. Остальные — при прокрутке.</p>':''}`;
}

// Высота по реальным трём строкам: учитывает годы, раскрытие этапа и ширину экрана.
export function syncGoalTimelines(root,ui,{restore=true}={}){
 for(const list of root.querySelectorAll('[data-goal-timeline]')){
  const rows=list.querySelectorAll('[data-scroll-row]');
  if(rows.length>3){
   const height=Math.ceil(rows[2].getBoundingClientRect().bottom-list.getBoundingClientRect().top+list.scrollTop);
   if(height>0)list.style.maxHeight=`${height}px`;
  }
  if(restore)list.scrollTop=ui.goalTimelineScroll?.[list.dataset.goalTimeline]??0;
 }
}

export function attachGoalTimelines(root,getCtx){
 root.addEventListener('scroll',ev=>{
  const list=ev.target;if(!list.matches?.('[data-goal-timeline]'))return;
  (getCtx().ui.goalTimelineScroll??={})[list.dataset.goalTimeline]=list.scrollTop;
 },true);
 root.addEventListener('click',ev=>{
  const toggle=ev.target.closest('[data-goal-history]');if(toggle)(getCtx().ui.goalTimelineScroll??={})[toggle.dataset.goalHistory]=0;
 });
 // Наблюдаем корень, а не каждую строку: внутреннее изменение высоты списка не зацикливает измерение.
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>syncGoalTimelines(root,getCtx().ui,{restore:false})).observe(root);
}
