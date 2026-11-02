/* Вымышленные данные для скриншотов руководства. Только локальный PGlite. */
import { fillSample } from '../../tests/fixtures/sample-plan.mjs';
import { createConfig } from '../../src/core/config.js';
import { generateYear } from '../../src/engine/income.js';
import { buildInstallmentSchedule } from '../../src/engine/debts.js';

export async function seedGuideData({rpc,user,account,today}) {
  const state=await rpc(user,'state_get',{p_account:account});
  const year=Number(today.slice(0,4))+1;
  const dirty=new Set();
  const store={state,update(domain,change){change(state[domain]);dirty.add(domain);}};
  state.savings.goals=[{id:'goal-gifts',title:'Подарки',kind_code:'gifts',currency_code:'RUB',priority:1,target_amount:0,starting_balance:18500,pace_amount:0,completed:false}];
  fillSample({store},year);
  state.savings.goals.find(g=>g.id==='goal-trip').starting_balance=25000;
  state.savings.goals.find(g=>g.id==='goal-cushion').starting_balance=60000;
  state.income.income_history=Array.from({length:12},(_,i)=>({year:year-1,month:i+1,amount:230000}));
  state.income.sick_leaves=[{id:'guide-sick',start_date:`${year-1}-11-10`,end_date:`${year-1}-11-16`,note:'Пример больничного',benefit_enabled:true,
    reason:'illness',insurance_years:9,insurance_months:0,earnings1:2100000,earnings2:2400000,
    employer_pay_date:`${year-1}-11-20`,sfr_pay_date:`${year-1}-11-23`}];
  state.expenses.expense_categories[0].monthly_amount=30000;
  state.expenses.expense_items=[{id:'food',category_id:'cat-life',title:'Продукты',amount:20000,sort_order:1},
    {id:'transport',category_id:'cat-life',title:'Транспорт',amount:10000,sort_order:2},
    {id:'cafe',category_id:'cat-joy',title:'Кафе',amount:0,percent_value:5,sort_order:1},
    {id:'cinema',category_id:'cat-joy',title:'Кино',amount:0,percent_value:2.5,sort_order:2}];
  state.debts.installments=[{id:'guide-installment',title:'Ноутбук',total:60000,parts:4,every_n:1,period_unit:'month',first_date:`${year}-02-05`,sort_order:1}];
  const schedule=buildInstallmentSchedule(state.debts.installments[0],createConfig(state).list('period_units'));
  state.debts.installment_payments=schedule;
  const cfg=createConfig(state);
  state.income.periods=[...state.income.periods.filter(p=>p.pay_date<=today),...generateYear(state,cfg,year,{round:cfg.formatter().round}),
    {id:'guide-bonus',year,title:'Разовая выплата',pay_date:`${year}-02-12`,window_start:`${year}-02-01`,window_end:`${year}-02-28`,calc_mode:'manual',income_net:10000,income_manual:true,taxable:false,manual_kind:'side_job',note:'Пример подработки'}];
  state.facts.expense_facts=[{category_id:'cat-life',item_key:'food',ym:`${year}-01`,amount:19000},
    {category_id:'cat-life',item_key:'transport',ym:`${year}-01`,amount:10500}];
  dirty.add('facts');
  for(const domain of dirty)await rpc(user,'state_save',{p_account:account,p_domain:domain,p_version:state.versions[domain],p_patch:state[domain]});
}
