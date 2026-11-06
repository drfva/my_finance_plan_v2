import {test} from 'node:test';
import assert from 'node:assert/strict';
import {goalTimeline,stageTimelineDate,syncGoalTimelines} from '../src/ui/goal-timeline.js';

const context=()=>({today:'2026-11-06',ui:{open:new Set()}});
const render=(ctx,items)=>goalTimeline(ctx,{key:'ms-hist:trip',items,dateOf:x=>x.date,render:x=>`<section data-scroll-row="${x.id}">${x.id}</section>`,label:'Этапы',pastLabel:'пройденные этапы',emptyNote:'Нет этапов.'});

test('год этапа задаёт срок, без срока — прогноз, неизвестная дата не выдумывается',()=>{
 assert.equal(stageTimelineDate({deadline:'2027-01-01'},{done:'2028-02-01'}),'2027-01-01');
 assert.equal(stageTimelineDate({deadline:null},{done:'2028-02-01'}),'2028-02-01');
 assert.equal(stageTimelineDate({deadline:null},{done:'pre'}),null);
 assert.equal(stageTimelineDate({},{done:null}),null);
});
test('прошедшие скрыты, сегодняшние и будущие видны; годы упорядочены',()=>{
 const ctx=context(),items=[{id:'later',date:'2028-03-01'},{id:'past',date:'2026-11-05'},{id:'today',date:ctx.today},{id:'unknown',date:null}];
 const html=render(ctx,items);
 assert.match(html,/Показать пройденные этапы \(1\)/);assert.doesNotMatch(html,/data-scroll-row="past"/);
 assert.ok(html.indexOf('data-scroll-row="today"')<html.indexOf('data-scroll-row="later"'));
 assert.match(html,/Без даты/);assert.doesNotMatch(html,/timeline-scroll/);
 ctx.ui.open.add('ms-hist:trip');const expanded=render(ctx,items);
 assert.match(expanded,/Скрыть пройденные этапы/);assert.match(expanded,/data-scroll-row="past"/);assert.match(expanded,/timeline-scroll/);
});
test('четвёртая запись включает прокрутку; годы не считаются записями',()=>{
 const rows=[2027,2028,2029,2030].map((year,i)=>({id:String(i),date:`${year}-01-01`}));
 assert.doesNotMatch(render(context(),rows.slice(0,3)),/timeline-scroll/);
 assert.match(render(context(),rows),/timeline-scroll/);
 assert.equal((render(context(),rows).match(/class="year-cap"/g)||[]).length,4);
});
test('сохранённая прошедшая запись раскрывается для перехода к ней',()=>{
 const ctx=context();ctx.ui.scrollTarget={row:'past'};
 assert.match(render(ctx,[{id:'past',date:'2025-12-30'}]),/data-scroll-row="past"/);
 assert.ok(ctx.ui.open.has('ms-hist:trip'));
});
test('полностью прошлый список сохраняет доступ к раскрытию без потери записей',()=>{
 const ctx=context(),items=[{id:'old',date:'2025-01-01'}],html=render(ctx,items);
 assert.match(html,/Все записи в прошлом/);assert.match(html,/id="goal-timeline-ms-hist:trip"/);assert.doesNotMatch(html,/data-scroll-row="old"/);
 ctx.ui.open.add('ms-hist:trip');assert.match(render(ctx,items),/data-scroll-row="old"/);
});
test('высота трёх записей учитывает заголовки годов и раскрытые подробности; позиция сохраняется',()=>{
 const list={dataset:{goalTimeline:'ms-hist:trip'},scrollTop:40,style:{},getBoundingClientRect:()=>({top:100}),querySelectorAll:()=>[{}, {},{getBoundingClientRect:()=>({bottom:690})},{}]};
 syncGoalTimelines({querySelectorAll:()=>[list]},{goalTimelineScroll:{'ms-hist:trip':125}});
 assert.equal(list.style.maxHeight,'630px');assert.equal(list.scrollTop,125);
});
