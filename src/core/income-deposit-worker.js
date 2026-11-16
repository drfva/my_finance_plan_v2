import { createConfig } from './config.js';
import { classifyIncomePeriods, computeIncome } from '../engine/income.js';

export async function postIncomeForPlan(rpc, planId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await rpc('expense_income_worker_read', { p_plan:planId });
    if (!state?.pending_income_receipts?.length) return 0;
    const cfg = createConfig(state);
    const { round } = cfg.formatter();
    const initial = computeIncome(state,cfg,{round});
    const classification = new Map(classifyIncomePeriods(initial).map(({id,manual})=>[id,manual]));
    const pending = new Set(state.pending_income_receipts);
    const entered = new Set(state.income.periods.filter(p=>p.income_manual === true
      || classification.get(p.id) === true && Number(p.income_net) > 0).map(p=>p.id));
    for (const period of state.income.periods) {
      if (classification.has(period.id)) period.income_manual = classification.get(period.id);
    }
    const income = classification.size ? computeIncome(state,cfg,{round}) : initial;
    const rows = income.periods.filter(({period:p,formula,salary,sick}) => {
      if (!pending.has(p.id) || !Number.isFinite(salary) || salary > 99999999999999) return false;
      if (p.locked || p.calc_mode === 'manual' && !p.sick_leave_id || entered.has(p.id) && !p.sick_leave_id) return true;
      return p.sick_leave_id ? !sick?.pendingTax : Boolean(formula && !formula.error && !formula.overpaid);
    }).map(({period,salary})=>({period_id:period.id,amount:Math.max(0,salary)}));
    if (!rows.length) return 0;
    try {
      return await rpc('expense_income_worker_post',{p_plan:planId,p_versions:state.versions,p_rows:rows});
    } catch (error) {
      if (error.code !== 'PT409' || attempt === 2) throw error;
    }
  }
}
