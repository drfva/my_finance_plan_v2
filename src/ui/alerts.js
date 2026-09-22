/* ---------------------------------------------------------------------
   alerts.js — где в плане «позже срока».

   Считает по каждой вкладке годы, в которых что-то не укладывается в срок:
   этапы копилок, подушек и подарков, у которых дата закрытия позже срока или
   которых план вовсе не достигает, и льготные периоды карт, закрытые с
   опозданием или не закрытые совсем. Оболочка ставит оранжевую точку рядом с
   названием вкладки и на таблетке года.
--------------------------------------------------------------------- */

import { cycleStatus } from '../engine/debts.js';
import { forecastBeyondPlan } from '../engine/allocation.js';

const yearOf = d => Number(String(d).slice(0, 4));

/* Годы с опозданием по целям одного типа */
function lateGoalYears(ctx, kinds) {
  const out = new Set();
  const goals = (ctx.state.savings?.goals ?? []).filter(g => kinds.includes(g.kind_code) && !g.completed);
  for (const g of goals) {
    const list = ctx.sim.milestonesOf(g);
    const dates = ctx.sim.milestoneDates[g.id] ?? [];
    list.forEach((m, i) => {
      if (!m.deadline) return;
      const done = dates[i];
      if (done === 'pre') return;
      if (done) { if (done > m.deadline) out.add(yearOf(m.deadline)); return; }
      // внутри плана не закрывается: смотрим, что говорит продлённый темп
      const far = forecastBeyondPlan(ctx.sim, g, i);
      if (!far || far.date > m.deadline) out.add(yearOf(m.deadline));
    });
  }
  return out;
}

/* Годы, где льготный период карты закрыт позже срока или не закрыт */
function lateCardYears(ctx) {
  const out = new Set();
  const planEnd = ctx.sim.planEnd;
  for (const cycles of Object.values(ctx.sim.cardCycles ?? {})) {
    for (const c of cycles) {
      const st = cycleStatus(c, planEnd);
      if (st === 'late' || st === 'unpaid') out.add(yearOf(c.deadline || c.start));
    }
  }
  return out;
}

/* Вкладка → годы с опозданием. Пустое множество — всё в графике. */
export function lateYears(ctx) {
  return {
    goals: lateGoalYears(ctx, ['bucket']),
    reserves: lateGoalYears(ctx, ['reserve']),
    gifts: lateGoalYears(ctx, ['gifts']),
    credits: lateCardYears(ctx),
  };
}
