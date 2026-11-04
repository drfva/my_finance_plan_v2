import { simulate, forecastBeyondPlan } from './allocation.js';
import { createConfig } from '../core/config.js';

export function planMetrics(state, today) {
  const cfg = createConfig(state), sim = simulate(state, cfg, { today, round: cfg.formatter().round });
  const types = new Map((state.savings?.goals ?? []).map(g => [g.id, g.kind_code]));
  const years = {};
  for (const r of sim.rows) {
    const y = years[r.period.year] ??= { income:0, expenses:0, reserve:0, gifts:0, buckets:0, free:0 };
    y.income += r.totalIncome;
    y.expenses += r.categoriesTotal + r.installmentsTotal + Object.values(r.debtPayments).reduce((a,b)=>a+b,0) + (r.familyContribution?.amount ?? 0);
    y.free += r.unallocated;
    for (const [id,amount] of Object.entries(r.allocations)) y[types.get(id)==='reserve'?'reserve':types.get(id)==='gifts'?'gifts':'buckets'] += amount;
  }
  const goals = (state.savings?.goals ?? []).filter(g => !g.completed && !g.archived).map(g => {
    const milestones = sim.milestonesOf(g);
    return { id:g.id, title:g.title, currency:g.currency_code, kind:g.kind_code,
      saved:sim.finalPhase.balances[g.id] ?? 0,
      stages:milestones.map((m,i) => ({ id:m.id ?? `${g.id}:${i}`, title:m.title || g.title, deadline:m.deadline || '',
        date:sim.milestoneDates[g.id]?.[i] || forecastBeyondPlan(sim,g,i)?.date || null })) };
  });
  return { years, goals, warnings:sim.warnings.map(w=>w.code), base:cfg.get('base_currency'), end:sim.planEnd };
}

export function comparePlans(before, after, today) {
  const left = planMetrics(before,today), right = planMetrics(after,today);
  return { before:left, after:right };
}

export function forecastChanges(comparison, year) {
  if (!comparison) return [];
  const a=comparison.before.years[year]??{}, b=comparison.after.years[year]??{};
  const names={income:'Доходы',expenses:'Расходы и обязательные платежи',reserve:'В подушки',gifts:'На подарки',buckets:'В копилки',free:'Свободный остаток'};
  const result=Object.entries(names).flatMap(([key,title])=>Math.abs((b[key]??0)-(a[key]??0))>0.5
    ?[{kind:'money',title,before:a[key]??0,after:b[key]??0,delta:(b[key]??0)-(a[key]??0),currency:comparison.after.base}]:[]);
  for(const goal of comparison.after.goals){
    const previous=comparison.before.goals.find(g=>g.id===goal.id);
    if(!previous)continue;
    for(const stage of goal.stages){
      const old=previous.stages.find(m=>m.id===stage.id);
      if(old&&old.date!==stage.date)result.push({kind:'date',title:stage.title,before:old.date,after:stage.date,deadline:stage.deadline});
    }
  }
  return result;
}
