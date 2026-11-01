import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createConfig } from '../src/core/config.js';
import { simulate } from '../src/engine/allocation.js';
import { familyToday } from '../src/engine/family.js';
import { render as renderSettings, planSwitch } from '../src/ui/settings.js';
import { render as renderPeriods } from '../src/ui/periods.js';
import { personalFamilyCard, renderFamily, handle, handleChange } from '../src/ui/family.js';
import {planYears} from '../src/ui/app.js';
import {familyYearBudget} from '../src/engine/family.js';

function context() {
  const state=JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json',import.meta.url),'utf8'));
  state.account.plan_kind='personal';
  state.income={periods:[{id:'p',year:2040,pay_date:'2040-11-05',window_start:'2040-11-01',window_end:'2040-11-05',calc_mode:'manual',income_net:100000,taxable:false}]};
  state.expenses={};state.debts={};state.savings={};state.gifts={};
  state.family_available=true;
  state.accounts=[{...state.account},{id:'f',title:'Наша семья',role:'owner',plan_kind:'family'}];
  state.family_connection={id:'f',title:'Наша семья',source_account_id:'a'};
  state.family_source_connected=true;
  state.family_private={membership:{id:'me',source_account_id:'a',family_id:'f',active:true,revision:1},
    rules:[{mode:'monthly',amount:40000,percent:20,cap_per_payment:15000,effective_from:'2026-10-01'}],overrides:[]};
  state.family={id:'f',title:'Наша семья',version:1,members:[
    {id:'me',is_self:true,active:true,role:'owner',nickname:'Анна',color:'purple',email:'anna@example.test'},
    {id:'other',is_self:false,active:true,role:'owner',nickname:'Саша',color:'green',email:'sasha@example.test'},
  ],invitations:[{id:'i',email:'sasha@example.test',status:'accepted'},{id:'j',email:'guest@example.test',status:'pending',delivery:'sent',expires_at:'2040-12-01'}],audit:[]};
  const cfg=createConfig(state),fmt=cfg.formatter(),sim=simulate(state,cfg),commands=[];
  const store={state,familyCommand:async(action,payload)=>{commands.push({action,payload});return {};}};
  return {state,cfg,fmt,sim,income:sim.income,store,commands,canEdit:true,today:familyToday(),year:2040,years:[2040],
    ui:{tab:'settings',open:new Set(['set:plan','set:family']),draft:{settings:{}}},notice:()=>{}};
}
const actionEvent=(op,value='')=>({target:{closest:selector=>selector==='[data-family-action]'?{dataset:{familyAction:op,value}}:null}});

function budgetContext(){
  const ctx=context();ctx.state.account.plan_kind='family';ctx.today='2040-11-10';ctx.ui.tab='periods';
  const f=ctx.state.family;
  f.categories=[{id:'food',title:'Отдых',mode:'percent_month',percent_value:90,monthly_amount:0},
    {id:'cafe',parent_id:'food',title:'Кафе',percent_value:5},{id:'cinema',parent_id:'food',title:'Кино',percent_value:7.5}];
  f.monthly_expenses=[];f.expense_facts=[];
  f.contributions=[{id:'old',member_id:'me',period_id:'old',pay_date:'2040-11-05',amount:1000,status:'posted'},
    {id:'mine',member_id:'me',period_id:'mine',pay_date:'2040-11-20',amount:4000,status:'forecast'},
    {id:'theirs',member_id:'other',period_id:'theirs',pay_date:'2040-11-21',amount:5000,status:'forecast'},
    {id:'dec',member_id:'me',period_id:'dec',pay_date:'2040-12-20',amount:20000,status:'forecast'}];
  f.budget={months:[{month:'2040-11',received:1000,future:9000,expected:10000,planned:1250,actual:0,unassigned:0,
    targets:[{category_id:'cafe',parent_id:'food',title:'Кафе',target:500},{category_id:'cinema',parent_id:'food',title:'Кино',target:750}]},
    {month:'2040-12',received:0,future:20000,expected:20000,planned:2500,actual:0,unassigned:0}],rows:f.contributions.map(c=>({contribution_id:c.id,member_id:c.member_id,period_id:c.period_id,pay_date:c.pay_date,locked:c.status==='posted',expenses:c.amount*.125,
      allocations:[{category_id:'cafe',parent_id:'food',title:'Кафе',parent_title:'Отдых',amount:c.amount*.05,manual:false},
        {category_id:'cinema',parent_id:'food',title:'Кино',parent_title:'Отдых',amount:c.amount*.075,manual:true}]}))};
  return ctx;
}
const budgetField=(column,id,value,extra={})=>({target:{closest:selector=>selector==='[data-family-budget-field]'?{dataset:{familyBudgetField:column,id,...extra},value}:null}});

test('семейный Обзор: итоги за год и взносы каждого участника, годы берутся из семейных данных',()=>{
  const ctx=budgetContext(),html=renderFamily(ctx,'dashboard');
  assert.match(html,/Взносы участников за год/);assert.match(html,/Итого за год/);
  assert.ok(html.includes(ctx.fmt.money(3750)));assert.ok(html.includes(ctx.fmt.money(30000)));
  assert.doesNotMatch(html,/family-month-nav/);
  assert.equal(familyYearBudget(ctx.state.family,2040).future,29000);
  ctx.state.family.contributions.push({pay_date:'2042-01-05',amount:100,status:'forecast'});
  assert.deepEqual(planYears(ctx.state,'2041-01-01'),[2040,2041,2042]);
});

test('семейные Доходы: цветные карточки, фильтры и защищённое прошлое',()=>{
  const ctx=budgetContext();ctx.ui.open.add('family-income:me:mine');ctx.ui.open.add('family-income:me:old');
  let html=renderFamily(ctx,'periods');
  assert.match(html,/family-income-card family-purple/);assert.match(html,/family-income-card family-green/);
  assert.match(html,/Расходы по категориям/);assert.match(html,/data-family-budget-field="allocation"/);
  const oldBody=html.split('id="family-income-old"')[1].split('</section>')[0];
  assert.doesNotMatch(oldBody,/data-family-budget-field="allocation"/);
  assert.equal(handleChange(budgetField('member-filter','','mine'),ctx),'render');
  html=renderFamily(ctx,'periods');assert.doesNotMatch(html,/family-income-card family-green/);
  handleChange(budgetField('member-filter','','other'),ctx);
  html=renderFamily(ctx,'periods');assert.doesNotMatch(html,/family-income-card family-purple/);
  assert.match(html,/family-income-card family-green/);
});

test('семейные категории: два месячных режима, сумма процентов подкатегорий и частичные правки',async()=>{
  const ctx=budgetContext();ctx.ui.open.add('family-cat:food');
  const html=renderFamily(ctx,'categories');
  assert.match(html,/Фиксированная сумма в месяц/);assert.match(html,/Фиксированный процент в месяц/);
  assert.doesNotMatch(html,/Процент от выплаты на руки/);
  assert.match(html,/data-family-budget-field="percent_value"[^>]*data-id="food"[^>]*value="12.5"[^>]* disabled/);
  assert.match(html,/\+ подкатегория/);
  handleChange(budgetField('percent_value','cafe','7,5'),ctx);await Promise.resolve();
  assert.deepEqual(ctx.commands[0],{action:'category',payload:{id:'cafe',percent_value:7.5}});
  ctx.canEdit=false;assert.doesNotMatch(renderFamily(ctx,'categories'),/data-family-budget-action=/);
});

test('семейные Расходы: план подкатегорий из серверного бюджета, архивная история остаётся видимой',()=>{
  const ctx=budgetContext();
  for(const c of ctx.state.family.categories)c.archived=true;
  const html=renderFamily(ctx,'facts');
  assert.match(html,/Отдых/);assert.match(html,/Кафе/);assert.match(html,/Кино/);
  assert.ok(html.includes(ctx.fmt.money(500)));assert.ok(html.includes(ctx.fmt.money(750)));
});

test('семейный бюджет: при недоступном расчёте не показываются ложные нулевые суммы и инструкции SQL',()=>{
  const ctx=budgetContext();delete ctx.state.family.budget;
  const html=renderFamily(ctx,'dashboard');
  assert.match(html,/Не удалось загрузить расчёт/);
  assert.doesNotMatch(html,/ПОЛУЧЕНО|Получено за год|SQL|supabase|family_api/);
});

test('настройки семьи: блоки раскрываются, текущий план выделен, название и роль стоят до переключения',()=>{
  const ctx=context(),html=renderSettings(ctx);
  assert.ok(html.indexOf('data-account-title')<html.indexOf('Доступные планы'));
  assert.match(planSwitch(ctx),/class="plan-choice current" aria-current="true"/);
  assert.match(planSwitch(ctx),/plan-choice available[^>]*data-open-plan="f"/);
  ctx.ui.open.delete('set:family');
  const closed=personalFamilyCard(ctx);
  assert.match(closed,/data-toggle="set:family" aria-expanded="false"/);
  assert.doesNotMatch(closed,/data-draft="mode"/);
});

test('форма отчислений: каждый способ показывает только свои параметры',()=>{
  const ctx=context();
  for(const mode of ['per_payment','monthly','percent','remainder']){
    ctx.ui.draft.settings.mode=mode;
    const html=personalFamilyCard(ctx);
    assert.equal(html.includes('data-draft="amount"'),['per_payment','monthly'].includes(mode),mode);
    assert.equal(html.includes('data-draft="percent"'),mode==='percent',mode);
    assert.equal(html.includes('data-draft="limit_scope"'),mode==='remainder',mode);
    assert.equal(html.includes('data-draft="limit_amount"'),mode==='remainder',mode);
    assert.equal(html.includes('data-draft="limit_percent"'),mode==='remainder',mode);
    assert.match(html,/data-draft="cap_per_payment"/);
  }
});

test('смена способа отчислений: скрытые параметры не мешают сохранению и не применяются',async()=>{
  const ctx=context();
  ctx.ui.draft.settings={mode:'percent',percent:'25',amount:'не сумма',limit_amount:'не сумма',limit_percent:'150'};
  handle(actionEvent('rule'),ctx);
  await Promise.resolve();
  assert.equal(ctx.commands.length,1);
  assert.deepEqual(ctx.commands[0].payload.rule,{mode:'percent',effective_from:familyToday(),amount:0,percent:25,
    cap_per_payment:15000,limit_amount:null,limit_percent:null,limit_scope:'payment'});
});

test('участники: редактируется только свой профиль; приглашения и выход находятся в этом блоке',()=>{
  const ctx=context(),html=renderFamily(ctx,'settings');
  assert.equal((html.match(/data-family-profile="nickname"/g)??[]).length,1);
  assert.doesNotMatch(html,/Мой профиль в семье|Мои отчисления|Участие в семье|<select data-draft="color"/);
  assert.match(html,/Приглашение отправлено/);
  assert.match(html,/Добро пожаловать в семью/);
  assert.match(html,/Уйти за хлебом и не вернуться/);
  assert.ok(html.indexOf('Доступные планы')<html.indexOf('Участники семьи'));
  ctx.ui.open.add('family-palette');
  const palette=renderFamily(ctx,'settings');
  assert.equal((palette.match(/data-family-action="profile-color"/g)??[]).length,5);
  assert.match(palette,/aria-label="Розовый"/);
});

test('свой профиль: изменение никнейма и выбор цвета сохраняют оба поля без чужого идентификатора',async()=>{
  const ctx=context();
  handleChange({target:{closest:selector=>selector==='[data-family-profile]'?{dataset:{familyProfile:'nickname'},value:'Катя'}:null}},ctx);
  handle(actionEvent('profile-color','pink'),ctx);
  await Promise.resolve();
  assert.deepEqual(ctx.commands.map(c=>c.payload),[{nickname:'Катя',color:'purple'},{nickname:'Катя',color:'pink'}]);
  assert.equal(ctx.commands.every(c=>c.action==='profile'),true);
});

test('выход из семьи: новый текст подтверждения, последнему участнику дополнительно сообщается об удалении',()=>{
  const saved=globalThis.confirm,messages=[];
  globalThis.confirm=message=>{messages.push(message);return false;};
  try{
    const ctx=context();
    handle(actionEvent('leave'),ctx);
    assert.equal(messages[0],'Вы точно хотите покинуть семью, оставить детей, собаку и даже того паука Гришу?');
    ctx.state.family.members.splice(1);
    handle(actionEvent('leave'),ctx);
    assert.match(messages[1],/Семейный план будет удалён/);
    assert.equal(ctx.commands.length,0);
  }finally{globalThis.confirm=saved;}
});

test('личная выплата: семейный блок после долгов, без плашки в заголовке; чужой источник не показывает блок',()=>{
  const ctx=context();ctx.ui.tab='periods';
  let html=renderPeriods(ctx);
  assert.doesNotMatch(html,/в семью|Отчисления в семейный план/);
  ctx.ui.open.add('period:p');
  ctx.state.debts.credit_cards=[{id:'c',title:'Карта',currency_code:'RUB'}];
  const row=ctx.sim.byId.get('p');row.cardBefore.c={debt:1000};row.debtPayments.c=100;
  row.installments=[{date:'2040-11-06',amount:100,installments:['i']}];
  html=renderPeriods(ctx);
  assert.ok(html.indexOf('Рассрочки из этой выплаты')<html.indexOf('Отчисления в семейный план'));
  assert.ok(html.indexOf('Кредитки')<html.indexOf('Отчисления в семейный план'));
  assert.match(html,/Спишется в дату выплаты/);
  assert.match(html,/40\s?000.*за месяц, пропорционально выплатам/);
  const block=html.slice(html.indexOf('Отчисления в семейный план'));
  assert.doesNotMatch(block,/прогноз/i);
  ctx.state.family_source_connected=false;ctx.state.family_private.membership.source_account_id='another';
  assert.doesNotMatch(renderPeriods(ctx),/Отчисления в семейный план/);
});
