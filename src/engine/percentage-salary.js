import {eachDay,daysInMonth} from './dates.js';
import {rateOn,salaryForWindow} from './salary.js';
import {payoutSchedule} from './calendar.js';

export function percentageScheduleError(year,slots){
  const own=slots.filter(s=>Number(s.year)===Number(year));
  if(own.some(s=>!Number.isFinite(Number(s.salary_percent||0))||Number(s.salary_percent)<0||Number(s.salary_percent)>100))return 'Процент каждой выплаты должен быть от 0 до 100.';
  const sum=own.reduce((n,s)=>n+Number(s.salary_percent||0),0);
  return !own.length||Math.abs(sum-100)>0.000001?'Для расчёта сумма процентов выплат года должна быть равна 100%.':null;
}

// Работает в начисленных суммах; НДФЛ применяется общим налоговым движком.
export function percentageSalary(p,{slots,rates,calendar,absences,previous,round}){
  const ym=p.window_start?.slice(0,7),year=Number(ym?.slice(0,4));
  const daysInWindow=calendar.workingDaysBetween(p.window_start,p.window_end);
  const empty={gross:0,grossTaxable:0,grossNet:0,windowDays:daysInWindow,workedDays:0,absentDays:daysInWindow,months:[],percentage:true};
  const error=percentageScheduleError(year,slots);
  if(error)return {...empty,error};
  const slot=slots.find(s=>Number(s.year)===year&&s.sort_order===p.slot_order);
  if(!slot)return {...empty,error:'Выплата отсутствует в процентном графике года.'};
  const scheduled=payoutSchedule(year,slots,calendar).filter(s=>s.window_start.startsWith(ym));
  const last=scheduled.at(-1)?.slot_order===p.slot_order;
  const end=`${ym}-${daysInMonth(year,Number(ym.slice(5,7)))}`;
  const full=salaryForWindow({start:ym+'-01',end,rates,calendar,absences,round});
  const own=salaryForWindow({start:p.window_start,end:p.window_end,rates,calendar,absences,round});
  if(last){
    const paid=previous.get(ym)||{taxable:0,net:0};
    const taxable=(full?.grossTaxable||0)-paid.taxable,net=(full?.grossNet||0)-paid.net;
    return {...empty,...own,percentage:true,settlement:true,percent:Number(slot.salary_percent),
      grossTaxable:Math.max(0,round(taxable)),grossNet:Math.max(0,round(net)),gross:Math.max(0,round(taxable))+Math.max(0,round(net)),
      overpaid:taxable<-.5||net<-.5};
  }
  const days=[...eachDay(p.window_start,p.window_end)].filter(d=>calendar.isWorkingDay(d));
  let taxable=0,net=0;
  for(const d of days){
    if(absences.some(([a,b])=>d>=a&&d<=b))continue;
    const rate=rateOn(rates,d);if(!rate)continue;
    const value=Number(rate.amount)*Number(slot.salary_percent)/100/days.length;
    if(rate.is_gross===false)net+=value;else taxable+=value;
  }
  return {...empty,...own,percentage:true,percent:Number(slot.salary_percent),grossTaxable:round(taxable),grossNet:round(net),gross:round(taxable)+round(net)};
}
