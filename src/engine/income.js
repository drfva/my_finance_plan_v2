/* ---------------------------------------------------------------------
   income.js — доход каждой выплаты. Собирает calendar, salary, tax и vacation.

     const inc = computeIncome(store.state, store.config());
     inc.periods          → выплаты по дате, у каждой:
       formula            — расчёт по окладу: gross, tax, net, рабочие дни (или null)
       salary             — доход на руки, который идёт в план (income_net выплаты)
       vacationPay        — отпускные, пришедшиеся на эту выплату
       extraIncome        — подарки и подработки с «учитывать в доходе»
       gross, tax, taxParts — начислено, удержано и по каким ставкам
       total              — всего доход выплаты
     inc.vacations        → по каждому отпуску: формула, сумма в плане, дата выплаты, деление
     inc.monthIncome(y,m) → доход месяца на руки (для отпускных и истории доходов)

   Правила, перенесённые из текущей версии:
   * в плане всегда участвует income_net — введённый или записанный при создании
     года доход на руки; formula — подсказка «по формуле»;
   * налог по формуле считается нарастающим итогом за год даты выплаты: в годовой
     доход по порядку дат входят фактические суммы выплат (пересчитанные в gross)
     и отпускные; выплата с taxable = false (по умолчанию — разовая) налогом не
     облагается и в нарастающий итог не попадает;
   * отпускные в доход месяца для расчёта отпускных не входят.
--------------------------------------------------------------------- */

import { createCalendar, payoutSchedule } from './calendar.js';
import { rateOn, salaryForWindow, absenceRanges } from './salary.js';
import { scaleForYear, taxForPayment, taxParts, grossFromNet, estimateMonthlyNet } from './tax.js';
import { vacationFormula, vacationPay, splitVacationPay } from './vacation.js';
import { createFx } from './fx.js';

const byDate = (a, b) => (a.pay_date < b.pay_date ? -1 : a.pay_date > b.pay_date ? 1 : String(a.id).localeCompare(String(b.id)));

export function calendarFor(state, cfg) {
  const inc = state.income ?? {};
  return createCalendar({
    refDays: cfg.list('calendar_days'),
    calendarCode: cfg.get('calendar_code'),
    accountDays: inc.account_calendar_days ?? [],
    workingDayOverrides: inc.working_day_overrides ?? [],
  });
}

export function computeIncome(state, cfg, { round = Math.round, fillIds = null, extraPeriods = [] } = {}) {
  const inc = state.income ?? {};
  const calendar = calendarFor(state, cfg);
  const rates = inc.salary_rates ?? [];
  const scales = inc.tax_scales ?? [];
  const brackets = inc.tax_brackets ?? [];
  const vacations = inc.vacations ?? [];
  const sickLeaves = inc.sick_leaves ?? [];
  const absences = absenceRanges(vacations, sickLeaves);
  const slots = inc.payout_slots ?? [];
  const history = new Map((inc.income_history ?? []).map(h => [`${h.year}-${h.month}`, h]));
  const periods = [...(inc.periods ?? []), ...extraPeriods].sort(byDate);
  const warnings = [];

  /* 1. Оклад по формуле для каждой выплаты */
  const formulaGross = new Map();
  for (const p of periods) {
    formulaGross.set(p.id, salaryForWindow({
      start: p.window_start, end: p.window_end, rates, calendar, absences, round,
    }));
  }

  /* 2. Доход месяца: выплаты за месяц, если они все на месте, иначе история доходов */
  const slotsPerYear = new Map();
  for (const s of slots) slotsPerYear.set(Number(s.year), (slotsPerYear.get(Number(s.year)) ?? 0) + 1);
  const periodsByMonth = new Map();
  for (const p of periods) {
    if (!p.window_start) continue;
    const key = `${Number(p.window_start.slice(0, 4))}-${Number(p.window_start.slice(5, 7))}`;
    if (!periodsByMonth.has(key)) periodsByMonth.set(key, []);
    periodsByMonth.get(key).push(p);
  }
  function monthIncome(y, m) {
    const key = `${y}-${m}`;
    const list = periodsByMonth.get(key) ?? [];
    const need = slotsPerYear.get(y) ?? 0;
    const sum = list.reduce((s, p) => s + (Number(p.income_net) || 0), 0);
    if (list.length && (need === 0 || list.length >= need)) return sum;
    if (history.has(key)) return Number(history.get(key).amount) || 0;
    return sum;
  }

  /* 3. Отпускные: формула, сумма в плане, деление по выплатам */
  const avgDaysInMonth = Number(cfg.get('avg_days_in_month'));
  const vacationInfo = vacations.map(v => {
    const formula = vacationFormula(v, { monthIncome, rates, sickLeaves, vacations, avgDaysInMonth }, round);
    const pay = vacationPay(v, formula);
    return {
      vacation: v,
      formula,
      pay,
      payDate: v.start_date ? calendar.workingDayBefore(v.start_date) : null,
      split: splitVacationPay(v, pay, periods),
    };
  });
  const vacationByPeriod = new Map();
  for (const vi of vacationInfo) {
    for (const part of vi.split) {
      if (!vacationByPeriod.has(part.period_id)) vacationByPeriod.set(part.period_id, []);
      vacationByPeriod.get(part.period_id).push({ vacation_id: vi.vacation.id, days: part.days, amount: part.amount });
    }
    const assigned = vi.split.reduce((s, x) => s + x.amount, 0);
    if (vi.pay && assigned !== vi.pay) {
      warnings.push({ code: 'vacation_outside_plan', vacation_id: vi.vacation.id, unassigned: vi.pay - assigned });
    }
  }

  /* 4. Подарки и подработки: в ближайшую выплату не позже даты */
  const fx = createFx(state.settings?.fx_rates ?? [], cfg.get('base_currency'));
  const extrasByPeriod = new Map();
  for (const e of inc.extra_incomes ?? []) {
    if (!e.counted_in_total || !e.date) continue;
    let amount = Number(e.amount) || 0;
    if (e.currency_code && e.currency_code !== fx.base) {
      const converted = fx.toBase(amount, e.currency_code, e.date);
      if (converted === null) { warnings.push({ code: 'no_fx_rate', extra_income_id: e.id, currency: e.currency_code }); continue; }
      amount = round(converted);
    }
    const target = [...periods].reverse().find(p => p.pay_date <= e.date);
    if (!target) { warnings.push({ code: 'extra_before_plan', extra_income_id: e.id }); continue; }
    if (!extrasByPeriod.has(target.id)) extrasByPeriod.set(target.id, []);
    extrasByPeriod.get(target.id).push({ extra_income_id: e.id, amount });
  }

  /* 5. Налог нарастающим итогом за год даты выплаты и итог выплаты */
  let cum = 0;
  let cumYear = null;
  const rows = periods.map(p => {
    const payYear = Number(p.pay_date.slice(0, 4));
    if (payYear !== cumYear) { cum = 0; cumYear = payYear; }
    const scale = scaleForYear(scales, brackets, payYear);

    const g = formulaGross.get(p.id);
    let formula = null;
    if (g) {
      const tax = taxForPayment(g.grossTaxable, cum, scale, round);
      formula = { ...g, tax, net: g.gross - tax };
    } else if (p.calc_mode !== 'manual') {
      warnings.push({ code: 'no_salary_rate', period_id: p.id });
    }

    const useFormula = fillIds && fillIds.has(p.id) && formula;
    const salary = useFormula ? formula.net : (Number(p.income_net) || 0);
    const cumBefore = cum;
    // разовая выплата без галочки «облагается налогом» в годовой доход не входит
    const taxable = p.taxable !== false;
    const salaryGross = !taxable ? salary : (useFormula ? formula.grossTaxable : grossFromNet(salary, cum, scale));
    cum += taxable ? salaryGross : 0;

    const vac = vacationByPeriod.get(p.id) ?? [];
    const vacationPayTotal = vac.reduce((s, x) => s + x.amount, 0);
    const vacationGross = vacationPayTotal > 0 ? grossFromNet(vacationPayTotal, cum, scale) : 0;
    cum += vacationGross;

    // сколько начислено и удержано в этой выплате — для истории доходов на обзоре
    const gross = round(salaryGross + vacationGross);
    const parts_ = taxable ? taxParts(salaryGross + vacationGross, cumBefore, scale, round) : [];
    const tax = Math.max(0, round(gross - salary - vacationPayTotal));

    const extras = extrasByPeriod.get(p.id) ?? [];
    const extraIncome = extras.reduce((s, x) => s + x.amount, 0);

    return {
      period: p,
      formula,
      salary,
      vacationPay: vacationPayTotal,
      vacations: vac,
      extraIncome,
      extras,
      gross,
      tax,
      taxParts: parts_,
      total: salary + vacationPayTotal + extraIncome,
    };
  });

  return {
    calendar,
    periods: rows,
    byId: new Map(rows.map(r => [r.period.id, r])),
    vacations: vacationInfo,
    monthIncome,
    warnings,
    rateOn: s => rateOn(rates, s),
    /* Оценка «на руки в месяц» по окладу на дату */
    monthlyNetOn(s) {
      const r = rateOn(rates, s);
      if (!r) return 0;
      if (r.is_gross === false) return Number(r.amount);
      return estimateMonthlyNet(Number(r.amount), scaleForYear(scales, brackets, Number(s.slice(0, 4))), round);
    },
  };
}

/* Новый год плана: выплаты по графику с доходом на руки по формуле.
   Уже существующие выплаты года (тот же слот и месяц) не дублируются.
   Возвращает строки для state.income.periods — добавить их вызывающий код. */
export function generateYear(state, cfg, year, { round = Math.round } = {}) {
  const inc = state.income ?? {};
  const calendar = calendarFor(state, cfg);
  const existing = new Set((inc.periods ?? []).map(p => p.id));
  const taken = new Set((inc.periods ?? []).map(p => `${p.year}|${p.slot_order}|${p.window_start}`));
  const fresh = payoutSchedule(year, inc.payout_slots ?? [], calendar)
    .filter(p => !existing.has(p.id) && !taken.has(`${p.year}|${p.slot_order}|${p.window_start}`));
  if (!fresh.length) return [];
  const result = computeIncome(state, cfg, { round, extraPeriods: fresh, fillIds: new Set(fresh.map(p => p.id)) });
  return fresh.map(p => ({ ...p, income_net: result.byId.get(p.id)?.formula?.net ?? 0 }));
}
