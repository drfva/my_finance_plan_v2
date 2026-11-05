import {esc} from './dom.js';

export const GOAL_TABS=[{code:'goals',title:'Копилки'},{code:'gifts',title:'Подарки'},{code:'reserves',title:'Подушки'}];
export const isGoalTab=code=>GOAL_TABS.some(tab=>tab.code===code);
export const mainTabCode=code=>isGoalTab(code)||code==='ledger'?'goals':code;
export const goalTabForKind=kind=>({bucket:'goals',gifts:'gifts',reserve:'reserves'}[kind]??'goals');
export const goalLateYears=late=>new Set(GOAL_TABS.flatMap(tab=>[...(late[tab.code]??[])]));

export function goalTabFromKey(current,key){
  const index=GOAL_TABS.findIndex(tab=>tab.code===current);
  if(index<0)return null;
  const next=key==='Home'?0:key==='End'?GOAL_TABS.length-1:key==='ArrowRight'?(index+1)%GOAL_TABS.length:
    key==='ArrowLeft'?(index+GOAL_TABS.length-1)%GOAL_TABS.length:-1;
  return next<0?null:GOAL_TABS[next].code;
}

export function goalNavigation(active,late={}){
  return `<div class="goal-tabs" role="tablist" aria-label="Виды целей">${GOAL_TABS.map(tab=>
    `<button id="goal-tab-${tab.code}" role="tab" aria-selected="${tab.code===active}" aria-controls="goal-panel"
      tabindex="${tab.code===active?0:-1}" data-goal-tab="${tab.code}">${esc(tab.title)}${late[tab.code]?.size?
      '<i class="late-dot" title="Есть сроки, в которые план не укладывается"></i>':''}</button>`).join('')}</div>`;
}
