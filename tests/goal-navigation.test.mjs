import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GOAL_TABS,mainTabCode,goalLateYears,goalNavigation,goalTabFromKey,goalTabForKind} from '../src/ui/goal-navigation.js';
import {handleHistory,renderHistory,handleHistoryChange} from '../src/ui/plan-history-view.js';

test('Цели: три внутренних вкладки, общая отметка просрочек и совместимость старых переходов',()=>{
  assert.deepEqual(GOAL_TABS.map(t=>t.title),['Копилки','Подарки','Подушки']);
  for(const code of ['goals','gifts','reserves','ledger'])assert.equal(mainTabCode(code),'goals');
  assert.equal(mainTabCode('settings'),'settings');
  assert.equal(goalTabForKind('reserve'),'reserves');
  const late={goals:new Set([2026]),gifts:new Set([2027]),reserves:new Set([2027,2028])};
  assert.deepEqual([...goalLateYears(late)],[2026,2027,2028]);
  const html=goalNavigation('gifts',late);
  assert.equal((html.match(/role="tab"/g)??[]).length,3);
  assert.equal((html.match(/aria-selected="true"/g)??[]).length,1);
  assert.match(html,/id="goal-tab-gifts" role="tab" aria-selected="true"/);
});

test('внутренние вкладки целей: клавиатурная навигация по кругу, Home и End',()=>{
  assert.equal(goalTabFromKey('goals','ArrowRight'),'gifts');
  assert.equal(goalTabFromKey('goals','ArrowLeft'),'reserves');
  assert.equal(goalTabFromKey('reserves','ArrowRight'),'goals');
  assert.equal(goalTabFromKey('gifts','Home'),'goals');
  assert.equal(goalTabFromKey('gifts','End'),'reserves');
  assert.equal(goalTabFromKey('goals','Tab'),null);
});

test('История: ссылка из объяснения открывает блок настроек и выбирает нужный год',()=>{
  const ctx={year:2026,years:[2026,2027],ui:{tab:'goals',open:new Set()},store:{history:()=>[]},canEdit:false};
  const event={target:{closest:selector=>selector==='[data-open-plan-history]'?{dataset:{openPlanHistory:'2027'}}:null}};
  assert.equal(handleHistory(event,ctx),true);
  assert.equal(ctx.ui.tab,'settings');
  assert.equal(ctx.ui.historyYear,2027);
  assert.ok(ctx.ui.open.has('set:plan-history'));
  assert.deepEqual(ctx.ui.scrollTarget,{section:'set:plan-history'});
  const html=renderHistory(ctx,{embedded:true});
  assert.match(html,/value="2027" selected/);
  assert.doesNotMatch(html,/<h2|data-history-undo/);
  assert.equal(handleHistoryChange({target:{closest:()=>({value:'2026'})}},ctx),true);
  assert.equal(ctx.ui.historyYear,2026);
});
