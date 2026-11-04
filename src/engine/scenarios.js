import { copy } from '../core/plan-history.js';
import { simulate } from './allocation.js';
import { createConfig } from '../core/config.js';
import { parseISODate } from '../core/format.js';

/* Сценарий — набор поправок к копии текущего плана. Запись в store не нужна. */
export function applyScenario(state, scenario, today){
  const next=copy(state),notes=[];
  next.expenses??={};next.expenses.expense_categories??=[];next.expenses.expense_period_overrides??=[];
  for(const [index,change] of (scenario.adjustments??[]).entries()){
    const amount=Number(change.amount);
    if(change.amount===null||change.amount===''||!Number.isFinite(amount))throw new Error('Укажите числовую сумму изменения');
    const from=change.from||today,to=change.to||'9999-12-31';
    if(!parseISODate(from)||!parseISODate(to)||to<from)throw new Error('Проверьте даты изменения');
    const cfg=createConfig(next),sim=simulate(next,cfg,{today,round:cfg.formatter().round});
    const rows=sim.rows.filter(r=>!r.period.locked&&r.period.pay_date>=from&&r.period.pay_date<=to);
    if(change.type==='fx'){
      if(amount<=-100)throw new Error('Курс нельзя уменьшить на 100% или больше');
      const code=change.target,rate=sim.savingsFx.rateOn(code,today);
      if(!code||code===cfg.get('base_currency')||rate===null)throw new Error('Для валютного сценария нужен доступный текущий курс');
      const quote={base_code:cfg.get('base_currency'),quote_code:code,rate_date:today,rate:rate*(1+amount/100),source:'Сценарий'};
      const fx=next.current_fx??={};fx.rates=[...(fx.rates??[]).filter(r=>r.quote_code!==code),quote];
      continue;
    }
    if(!rows.length){notes.push('В выбранном интервале нет незакреплённых выплат: изменение не распределено.');continue;}
    if(change.type==='income'){
      const salaryRows=rows.filter(row=>next.income.periods.some(p=>p.id===row.period.id&&!p.sick_leave_id));
      const months=new Map();for(const row of salaryRows){const month=(row.period.window_start||row.period.pay_date).slice(0,7);months.set(month,(months.get(month)??0)+1);}
      for(const row of salaryRows){
        const p=next.income.periods.find(p=>p.id===row.period.id);
        if(!p||p.sick_leave_id)continue;
        const month=(p.window_start||p.pay_date).slice(0,7),salary=row.income.salary+amount/months.get(month);
        if(salary<0)throw new Error('Изменение делает выплату отрицательной. Уменьшите снижение дохода');
        p.calc_mode='manual';p.income_manual=true;p.income_net=salary;
      }
      continue;
    }
    if(!['expense','purchase'].includes(change.type))throw new Error('Неизвестный вид сценария');
    const id=change.target||`scenario-expense-${index}`;
    if(!next.expenses.expense_categories.some(c=>c.id===id))next.expenses.expense_categories.push({id,title:change.type==='purchase'?'Покупка в сценарии':'Дополнительные расходы',mode:'fixed_month',monthly_amount:0,split_mode:'even'});
    let affected=rows;
    if(change.type==='purchase'){
      if(amount<0)throw new Error('Сумма покупки должна быть положительной');
      const available=sim.rows.filter(r=>!r.period.locked&&r.period.pay_date>=today&&r.period.pay_date<=from);
      if(!available.length){notes.push('До даты покупки нет незакреплённой выплаты: покупка не распределена.');continue;}
      affected=[available.at(-1)];
    }
    const counts=new Map();for(const r of affected){const month=(r.period.window_start||r.period.pay_date).slice(0,7);counts.set(month,(counts.get(month)??0)+1);}
    for(const row of affected){
      const month=(row.period.window_start||row.period.pay_date).slice(0,7),base=row.expenses.categories.find(c=>c.category_id===id)?.amount??0;
      const value=base+(change.type==='purchase'?amount:amount/counts.get(month));
      if(value<0)throw new Error('Снижение расходов превышает сумму категории в выплате');
      const overrides=next.expenses.expense_period_overrides;
      const old=overrides.find(o=>o.period_id===row.period.id&&o.category_id===id);
      if(old)old.amount=value;else overrides.push({period_id:row.period.id,category_id:id,amount:value});
    }
  }
  return {state:next,notes};
}
