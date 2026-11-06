import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createConfig} from '../src/core/config.js';
import {createTracker,progressOf,syncGenerated} from '../src/engine/savings.js';
import {simulate,goalBalanceAt,goalProgressAt,goalMilestoneAt,snapshotGoalCompletion,forecastBeyondPlan} from '../src/engine/allocation.js';
import {goalOperationRows,saveGoalModal} from '../src/ui/goal-operations.js';
import {render as renderGoals,milestoneStatus} from '../src/ui/goals.js';
import {deleteRow} from '../src/ui/edit.js';
import {ledgerTable} from '../src/ui/ledger.js';

function context({stages=false,txs=[],periods=[],starting=20000,target=100000,deadline='2027-04-01',today='2026-12-30'}={}){
 const state=JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
 Object.assign(state.income,{periods,plan_years:[{year:2027}],salary_rates:[],vacations:[],sick_leaves:[],extra_incomes:[]});
 state.expenses={expense_categories:[],expense_items:[],expense_period_overrides:[]};state.debts={credit_cards:[],credit_card_ops:[],credit_payment_overrides:[],installments:[],installment_payments:[]};
 state.savings={goals:[{id:'trip',title:'Путешествия',kind_code:'bucket',priority:1,currency_code:'RUB',starting_balance:starting,target_amount:target,deadline,completed:false}],goal_milestones:stages?[{id:'y2027',goal_id:'trip',title:'Путешествие 2027',target,deadline,source:'manual'},{id:'y2028',goal_id:'trip',title:'Путешествие 2028',target:120000,deadline:'2028-04-01',source:'manual'}]:[],goal_transactions:txs,goal_cycles:[],goal_cycle_skips:[],savings_period_overrides:[]};
 const cfg=createConfig(state),ctx={state,cfg,fmt:cfg.formatter(),canEdit:true,today,year:2027,years:[2027],ui:{open:new Set(),draft:{}}};
 ctx.sim=simulate(state,cfg,{today});ctx.store={state,update(domain,fn){fn(state[domain]);}};return ctx;
}
const tx=(purpose='goal',extra={})=>({id:'tickets',goal_id:'trip',kind:'spend',purpose,amount:10000,date:'2026-12-30',...extra});
const payouts=amount=>[1,2,3,4,5,6].map(m=>({id:'p'+m,year:2027,pay_date:`2027-${String(m).padStart(2,'0')}-20`,calc_mode:'manual',income_net:amount,taxable:false,window_start:`2027-${String(m).padStart(2,'0')}-01`,window_end:`2027-${String(m).padStart(2,'0')}-28`}));

test('покупка для цели: 20 000 − 10 000 на билеты, осталось накопить 80 000',()=>{const c=context({txs:[tx()]});const g=c.state.savings.goals[0];assert.equal(goalBalanceAt(c.sim,g,c.state.savings.goal_transactions,c.today),10000);assert.equal(goalProgressAt(c.sim,g,c.today),20000);assert.deepEqual(goalMilestoneAt(c.sim,g,0,c.today),{balance:10000,paid:10000,need:80000});});
test('трата на другое: из 20 000 осталось 10 000, накопить надо 90 000',()=>{const c=context({txs:[tx('other')]});assert.deepEqual(goalMilestoneAt(c.sim,c.state.savings.goals[0],0,c.today),{balance:10000,paid:0,need:90000});});
test('старая трата без назначения сохраняет поведение',()=>{const c=context({txs:[tx(undefined,{purpose:undefined})]});assert.equal(goalMilestoneAt(c.sim,c.state.savings.goals[0],0,c.today).need,90000);});
test('покупка всей стоимости при недоборе 8454 не закрывает этап ни до, ни в день, ни после срока',()=>{
 for(const date of ['2028-09-10','2028-09-21','2028-09-26']){
  const g={id:'g',starting_balance:291546},ms=[{id:'japan',goal_id:'g',title:'Поездка',target:300000,deadline:'2028-09-21'}],t=createTracker({goals:[g],milestones:ms,today:'2026-11-06'});
  t.apply({id:'purchase',goal_id:'g',kind:'spend',purpose:'goal',milestone_id:'japan',amount:300000,date});
  assert.equal(t.balance('g'),-8454,date);
  assert.equal(t.milestoneDates().g[0],null,date);
  assert.equal(t.phase('g').idx,0,date);
  assert.equal(progressOf(ms,t.phase('g')),291546,date);
  t.deposit('g',8454,'2028-10-20');
  assert.equal(t.balance('g'),0);
  assert.equal(t.milestoneDates().g[0],'2028-10-20');
  assert.equal(progressOf(ms,t.phase('g')),300000);
 }
});
test('до и после срока покупка для ненакопленного этапа сохраняет недобор, трата на другое увеличивает его',()=>{
 for(const date of ['2028-09-10','2028-09-26'])for(const purpose of ['goal','other']){
  const c=context({starting:20000,target:100000,deadline:'2028-09-21',today:'2028-10-01',txs:[tx(purpose,{date})]}),g=c.state.savings.goals[0];
  assert.equal(goalBalanceAt(c.sim,g,c.state.savings.goal_transactions,c.today),10000);
  assert.equal(goalMilestoneAt(c.sim,g,0,c.today).need,purpose==='goal'?80000:90000);
  assert.equal(c.sim.milestoneDates.trip[0],null);
 }
});
test('прогноз и остаток этапа учитывают долг покупки и закрывают его только в дату пополнения',()=>{
 const periods=[{id:'last',year:2028,pay_date:'2028-09-20',calc_mode:'manual',income_net:291546,taxable:false},{id:'repay',year:2028,pay_date:'2028-10-20',calc_mode:'manual',income_net:8454,taxable:false}];
 const c=context({starting:0,target:300000,deadline:'2028-09-21',today:'2026-11-06',periods,txs:[tx('goal',{date:'2028-09-26',amount:300000})]}),g=c.state.savings.goals[0];
 assert.equal(c.sim.milestoneDates.trip[0],'2028-10-20');
 assert.equal(goalMilestoneAt(c.sim,g,0,'2028-09-26').need,8454);
 assert.equal(goalProgressAt(c.sim,g,'2028-09-26'),291546);
 assert.equal(goalMilestoneAt(c.sim,g,0,'2028-10-20').need,0);
 assert.equal(c.sim.byId.get('repay').allocations.trip,8454);
});
test('частичное погашение покупки уменьшает недобор; прошлые строки истории неизменны',()=>{
 const g={id:'g',starting_balance:20000},ms=[{id:'a',goal_id:'g',target:30000,deadline:'2028-09-21'}],t=createTracker({goals:[g],milestones:ms});
 t.apply({goal_id:'g',kind:'spend',purpose:'goal',milestone_id:'a',amount:30000,date:'2028-09-26'});
 const history=structuredClone(t.ledger('g'));
 t.deposit('g',4000,'2028-10-01');
 assert.equal(t.phase('g').purchaseDebt[0],6000);assert.equal(progressOf(ms,t.phase('g')),24000);assert.equal(t.milestoneDates().g[0],null);
 assert.deepEqual(t.ledger('g').slice(0,history.length),history);
 t.apply({goal_id:'g',kind:'transfer_in',amount:6000,date:'2028-10-20'});
 assert.equal(t.milestoneDates().g[0],'2028-10-20');assert.equal(progressOf(ms,t.phase('g')),30000);
 assert.equal(t.ledger('g').reduce((sum,e)=>sum+e.delta,0),t.balance('g'));
});
test('необеспеченная покупка позднего этапа не закрывает его и не скрывает недобор раннего',()=>{
 const g={id:'g',starting_balance:50},ms=[{id:'a',goal_id:'g',target:100,deadline:'2028-04-01'},{id:'b',goal_id:'g',target:120,deadline:'2028-09-21'}],t=createTracker({goals:[g],milestones:ms});
 t.apply({goal_id:'g',kind:'spend',purpose:'goal',milestone_id:'b',amount:120,date:'2028-02-01'});
 assert.deepEqual(t.milestoneDates().g,[null,null]);assert.equal(t.phase('g').purchaseDebt[1],70);assert.equal(progressOf(ms,t.phase('g')),50);
 t.deposit('g',70,'2028-03-01');
 assert.deepEqual(t.milestoneDates().g,[null,'2028-03-01']);assert.equal(progressOf(ms,t.phase('g')),120);
 t.deposit('g',100,'2028-03-20');assert.deepEqual(t.milestoneDates().g,['2028-03-20','2028-03-01']);
});
test('покупка после срока накопленного этапа сохраняет его выполнение и деньги следующего этапа',()=>{
 const c=context({stages:true,starting:220000,today:'2027-04-03',txs:[tx('goal',{milestone_id:'y2027',date:'2027-04-02'})]}),g=c.state.savings.goals[0];
 assert.equal(goalMilestoneAt(c.sim,g,0,c.today).balance,90000);assert.equal(goalMilestoneAt(c.sim,g,1,c.today).balance,120000);
 assert.equal(goalProgressAt(c.sim,g,c.today),220000);assert.equal(c.sim.milestoneDates.trip[0],'pre');
});
test('история и ручное закрытие сохраняют недобор покупки вместо ложного завершения этапа',()=>{
 const c=context({starting:291546,target:300000,deadline:'2028-09-21',today:'2028-09-26',txs:[tx('goal',{date:'2028-09-26',amount:300000})]}),g=c.state.savings.goals[0];
 const html=ledgerTable(c,g),snapshot=snapshotGoalCompletion(c.sim,g,c.today);
 assert.ok(html.includes(c.fmt.money(291546)));assert.ok(html.includes(c.fmt.money(-8454)));
 assert.doesNotMatch(html,/все этапы закрыты|закрыт 1\./);
 assert.equal(snapshot.progress,291546);assert.equal(snapshot.phase.purchaseDebt[0],8454);assert.equal(snapshot.milestones[0].date,null);
 g.completed=true;g.completion_snapshot=snapshot;c.sim=simulate(c.state,c.cfg,{today:c.today});
 assert.equal(goalProgressAt(c.sim,g,'2028-10-20'),291546);
});
test('покупка привязана только к своему этапу, ближайший теряет заимствованные деньги',()=>{const c=context({stages:true,txs:[tx('goal',{milestone_id:'y2028'})]});const g=c.state.savings.goals[0];assert.equal(goalMilestoneAt(c.sim,g,0,c.today).need,90000);assert.equal(goalMilestoneAt(c.sim,g,1,c.today).paid,10000);assert.equal(goalMilestoneAt(c.sim,g,1,c.today).need,110000);});
test('будущая покупка не меняет сегодняшние деньги и прогресс',()=>{const c=context({txs:[tx('goal',{date:'2027-02-01'})],periods:payouts(30000)}),g=c.state.savings.goals[0];assert.equal(goalProgressAt(c.sim,g,c.today),20000);assert.equal(goalBalanceAt(c.sim,g,c.state.savings.goal_transactions,c.today),20000);assert.equal(goalMilestoneAt(c.sim,g,0,'2027-02-01').paid,10000);});
test('покупка до срока не требует второй копии денег и сохраняет срок',()=>{const base=context({periods:payouts(30000)}),c=context({periods:payouts(30000),txs:[tx('goal',{date:'2027-02-01'})]});assert.equal(c.sim.milestoneDates.trip[0],base.sim.milestoneDates.trip[0]);assert.ok(c.sim.milestoneDates.trip[0]<='2027-04-01');});
test('после достижения двух этапов трата по первому сохраняет второй обеспеченным',()=>{const c=context({stages:true,starting:220000,txs:[tx('goal',{milestone_id:'y2027'})]}),g=c.state.savings.goals[0];assert.equal(goalMilestoneAt(c.sim,g,0,c.today).balance,90000);assert.equal(goalMilestoneAt(c.sim,g,1,c.today).balance,120000);assert.equal(c.sim.milestoneDates.trip[1],'pre');});
test('закрытие цели фиксирует покупку между выплатами; снимок переживает новый расчёт',()=>{const c=context({txs:[tx()]}),g=c.state.savings.goals[0],snapshot=snapshotGoalCompletion(c.sim,g,c.today);assert.equal(snapshot.progress,20000);g.completed=true;g.completion_snapshot=snapshot;const sim=simulate(c.state,c.cfg,{today:c.today});assert.equal(goalProgressAt(sim,g,'2027-01-01'),20000);});
test('расчёт не выдумывает дату при нехватке денег; опоздание имеет дату',()=>{const no=context({periods:payouts(1000)});assert.equal(no.sim.milestoneDates.trip[0],null);const late=context({periods:payouts(15000),deadline:'2027-02-01'});assert.ok(late.sim.milestoneDates.trip[0]>'2027-02-01');assert.equal(milestoneStatus(late,late.state.savings.goals[0],late.sim.milestonesOf(late.state.savings.goals[0])[0]).cls,'warn');});
test('без срока: прогноз внутри плана обычный, за пределами более прозрачный',()=>{const c=context({periods:payouts(5000),deadline:null}),g=c.state.savings.goals[0];assert.equal(c.sim.milestoneDates.trip[0],null);assert.ok(forecastBeyondPlan(c.sim,g).date>'2027-06-20');const html=renderGoals(c);assert.match(html,/goal-forecast beyond/);const ready=context({periods:payouts(30000),deadline:null});assert.doesNotMatch(renderGoals(ready),/goal-forecast beyond/);});
test('модальная операция требует свой этап и после сохранения открывает Движения',()=>{const c=context({stages:true}),draft={goal_id:'trip',kind:'spend',purpose:'goal',milestone_id:'foreign',amount:'10000',date:c.today,title:'Билеты'};assert.throws(()=>goalOperationRows(c,draft),/Выберите этап/);draft.milestone_id='y2027';c.ui.goalModal={kind:'operation',goal_id:'trip',draft};saveGoalModal(c);assert.equal(c.ui.goalModal,null);assert.equal(c.ui.goalViews.trip,'movements');assert.equal(c.state.savings.goal_transactions[0].milestone_id,'y2027');assert.equal(c.ui.lastGoalTransaction,c.state.savings.goal_transactions[0].id);});
test('операция в прошлом после сохранения раскрывает скрытые движения',()=>{
 const c=context();c.ui.goalModal={kind:'operation',goal_id:'trip',draft:{goal_id:'trip',kind:'deposit',amount:'500',date:'2026-12-29',title:'Вчера'}};
 saveGoalModal(c);assert.ok(c.ui.open.has('tx-hist:trip'));assert.match(renderGoals(c),/Вчера/);
});
test('карточка скрывает прошлые этапы и показывает год прогноза этапа без срока',()=>{
 const c=context({stages:true,periods:payouts(30000)});
 c.state.savings.goal_milestones[0].deadline='2026-12-01';c.state.savings.goal_milestones[1].deadline=null;
 c.sim=simulate(c.state,c.cfg,{today:c.today});const html=renderGoals(c);
 assert.doesNotMatch(html,/data-scroll-row="y2027"/);assert.match(html,/Показать пройденные этапы \(1\)/);
 assert.match(html,/<div class="year-cap">2027<\/div>/);assert.match(html,/data-scroll-row="y2028"/);
 c.ui.open.add('ms-hist:trip');assert.match(renderGoals(c),/data-scroll-row="y2027"/);
});
test('первый этап принимает покупки общей цели; удаление привязанного этапа запрещено',()=>{const c=context({txs:[tx()]});c.ui.goalModal={kind:'stage',goal_id:'trip',draft:{title:'2027',amount:'100000',date:'2027-04-01'}};saveGoalModal(c);const m=c.state.savings.goal_milestones[0];assert.equal(c.state.savings.goal_transactions[0].milestone_id,m.id);assert.throws(()=>deleteRow(c.store,'savings','goal_milestones',{id:m.id}),/привязаны покупки/);});
test('повторение сохраняет связи покупок и разворачивается до конца нового года без выплат',()=>{const c=context({stages:true,txs:[tx('goal',{milestone_id:'y2027'})]});c.ui.goalModal={kind:'repeat',goal_id:'trip',draft:{title:'Путешествие',amount:'100000',date:'2027-04-01',period_unit:'year',milestone_id:'y2027'}};saveGoalModal(c);const id=c.state.savings.goal_transactions[0].milestone_id;assert.ok(id.startsWith('cyc:'));assert.ok(c.state.savings.goal_milestones.some(m=>m.id===id));const next=syncGenerated({savings:c.state.savings,until:'2030-12-31',years:[2027,2030],today:c.today});assert.ok(next.goal_milestones.some(m=>m.deadline==='2030-04-01'));assert.equal(next.goal_transactions[0].milestone_id,id);});
test('текущий прогресс трекера не засчитывает одну покупку дважды',()=>{const goal={id:'g',starting_balance:20,target_amount:100};const t=createTracker({goals:[goal],milestones:[]});t.apply({goal_id:'g',kind:'spend',purpose:'goal',amount:10,date:'2027-01-01'});t.deposit('g',80,'2027-02-01');assert.equal(progressOf([{target:100}],t.phase('g')),100);assert.equal(t.balance('g'),90);});
test('нулевое пополнение не дублирует предыдущее движение в снимке закрытия',()=>{const c=context({starting:0,txs:[{id:'in',goal_id:'trip',kind:'deposit',amount:10000,date:'2026-12-29'},{id:'zero',goal_id:'trip',kind:'deposit',amount:0,date:'2026-12-30'}]}),g=c.state.savings.goals[0];assert.equal(snapshotGoalCompletion(c.sim,g,c.today).progress,10000);});
test('перевод в валютную копилку сохраняет эквивалент обеих сторон и корректно редактируется со входящей стороны',()=>{
 const c=context();c.state.savings.goals.push({id:'usd',title:'Доллары',kind_code:'bucket',currency_code:'USD',target_amount:1000,priority:2,starting_balance:0});c.state.settings.fx_rates=[{base_code:'RUB',quote_code:'USD',rate:100,rate_date:'2026-12-30'}];c.sim=simulate(c.state,c.cfg,{today:c.today});
 const first=goalOperationRows(c,{goal_id:'trip',kind:'transfer',amount:'10000',date:c.today,to:'usd',title:'Перевод'});
 assert.equal(first.rows[0].amount,10000);assert.equal(first.rows[1].amount,100);assert.equal(first.rows[1].kind,'transfer_in');
 c.state.savings.goal_transactions=first.rows;
 const edited=goalOperationRows(c,{goal_id:'usd',id:first.rows[1].id,kind:'transfer',direction:'in',amount:'50',date:c.today,to:'trip',title:'Правка'});
 assert.equal(edited.remove.size,2);assert.equal(edited.rows[0].amount,50);assert.equal(edited.rows[0].kind,'transfer_in');assert.equal(edited.rows[1].amount,5000);assert.equal(edited.rows[1].kind,'transfer_out');
});
test('полностью оплаченный поздний этап не мешает заметить недобор предыдущего',()=>{
 const g={id:'g',starting_balance:200},ms=[{id:'a',goal_id:'g',target:100,deadline:'2027-04-01'},{id:'b',goal_id:'g',target:120,deadline:'2028-04-01'}],t=createTracker({goals:[g],milestones:ms,today:'2026-12-30'});
 t.apply({goal_id:'g',kind:'spend',purpose:'goal',milestone_id:'b',amount:120,date:'2026-12-30'});t.deposit('g',20,'2027-01-01');t.withdraw('g',10,'2027-01-02');
 assert.equal(t.milestoneDates().g[0],null);assert.equal(t.milestoneDates().g[1],'2026-12-30');assert.equal(progressOf(ms,t.phase('g')),210);
});
