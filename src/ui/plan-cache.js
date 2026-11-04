import { computeIncome } from '../engine/income.js';
import { simulate } from '../engine/allocation.js';

/* Store заменяет config при изменении данных и при загрузке ответа сервера.
   Открытие меню, фокус и черновики не требуют нового расчёта всего плана. */
export function createPlanCache({ incomeOf = computeIncome, simulatePlan = simulate } = {}) {
  let cached;
  return (state, cfg) => {
    const fmt = cached?.cfg === cfg ? cached.fmt : cfg.formatter();
    const today = fmt.todayISO();
    if (cached?.state === state && cached.cfg === cfg && cached.today === today) return cached;
    const income = incomeOf(state, cfg, { round: fmt.round });
    const sim = simulatePlan(state, cfg, { income, round: fmt.round, today });
    cached = { state, cfg, fmt, today, income, sim };
    return cached;
  };
}
