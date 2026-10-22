/* ---------------------------------------------------------------------
   income.js — доход каждой выплаты. Собирает calendar, salary, tax и vacation.

     const inc = computeIncome(store.state, store.config());
     inc.periods          → выплаты по дате, у каждой:
       formula            — расчёт по окладу: gross, tax, net, рабочие дни (или null)
       salary             — доход на руки, который идёт в план (income_net выплаты)
       vacationPay        — отпускные этой выплаты на руки (vacationGross минус vacationTax)
       extraIncome        — подарки и подработки с «учитывать в доходе»
       gross, tax, taxParts — начислено, удержано и по каким ставкам
       total              — всего доход выплаты
     inc.vacations        → по каждому отпуску: формула, сумма в плане, дата выплаты, деление
     inc.monthIncome(y,m) → доход месяца на руки
     inc.monthGross(y,m)  → начислено за месяц (оклад и премии) — база для отпускных

   Правила, перенесённые из текущей версии:
   * автоматические незакреплённые выплаты пересчитываются по формуле;
     income_manual сохраняет ручную сумму, locked — всю историю выплаты;
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
import { computeSickLeaves, sickPeriods, splitSickPay } from './sick.js';

const byDate = (a, b) => (a.pay_date < b.pay_date ? -1 : a.pay_date > b.pay_date ? 1 : String(a.id).localeCompare(String(b.id)));

export const automaticIncome = p => p.calc_mode !== 'manual' && !p.locked && p.income_manual === false;

/* У старых выплат происхождение суммы неизвестно. Отличающиеся значения
   сохраняем, совпавшие с формулой подключаем к автоматическому пересчёту. */
export function classifyIncomePeriods(income) {
  return income.periods.filter(r => r.period.income_manual == null).map(r => ({
    id: r.period.id,
    manual: r.period.calc_mode === 'manual' || !r.formula
      || Math.abs((Number(r.period.income_net) || 0) - r.formula.net) > 0.5,
  }));
}

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
  const sickInfo = computeSickLeaves(inc);
  if (cfg.get('base_currency') !== 'RUB') {
    for (const f of sickInfo) if (!f.disabled) f.errors.push('Автоматические поступления больничного поддерживаются в плане с базовой валютой RUB: суммы пособия и НДФЛ считаются в рублях.');
  }
  const preparedPeriods = sickPeriods(inc);
  const periods = [...preparedPeriods, ...extraPeriods].sort(byDate);
  const warnings = [];
  const sickByPeriod = new Map();
  for (const f of sickInfo) {
    f.split = splitSickPay(f, periods);
    for (const part of f.split) {
      if (!sickByPeriod.has(part.period_id)) sickByPeriod.set(part.period_id, []);
      sickByPeriod.get(part.period_id).push(part);
      const target = periods.find(p => p.id === part.period_id);
      if (target?.locked && !target.sick_snapshot?.some(x => x.leave_id === part.leave_id && x.payer === part.payer)) {
        warnings.push({ code: 'sick_locked_period', sick_leave_id: part.leave_id, period_id: target.id });
      }
    }
    if (!f.disabled && !f.errors.length) for (const payer of ['employer', 'sfr']) {
      if (periods.some(p => p.locked && p.sick_leave_id === f.leave.id && p.sick_payer === payer)) continue;
      const total = payer === 'employer' ? f.employerGross : f.sfrGross;
      const assigned = f.split.filter(p => p.payer === payer).reduce((n, p) => n + p.gross, 0);
      if (total - assigned > 0.01) warnings.push({ code: 'sick_outside_plan', sick_leave_id: f.leave.id, payer, unassigned: total - assigned });
    }
  }
  const sickPartsFor = p => p.locked ? p.sick_snapshot ?? [] : sickByPeriod.get(p.id) ?? [];

  /* 1. Оклад по формуле для каждой выплаты */
  const formulaGross = new Map();
  for (const p of periods) {
    formulaGross.set(p.id, p.sick_leave_id ? null : salaryForWindow({
      start: p.window_start, end: p.window_end, rates, calendar, absences, round,
    }));
  }

  /* 2. Начислено по каждой выплате (gross). Средний заработок для отпускных
        считается в начисленных суммах, а в плане выплаты живут «на руки», поэтому
        gross получается обратным пересчётом по шкале нарастающим итогом.
        Этот проход идёт без отпускных — они добавляются ниже, когда посчитаны. */
  const grossOfPeriod = new Map();
  {
    let cum = 0;
    let cumYear = null;
    for (const p of periods) {
      const payYear = Number(p.pay_date.slice(0, 4));
      if (payYear !== cumYear) { cum = 0; cumYear = payYear; }
      if (p.sick_leave_id) {
        if (p.sick_payer === 'employer') cum += Number(p.sick_gross) || 0;
        continue;
      }
      const scale = scaleForYear(scales, brackets, payYear);
      const net = Number(p.income_net) || 0;
      const taxable = p.taxable !== false;
      const f = formulaGross.get(p.id);
      const useFormula = f && (automaticIncome(p) || fillIds?.has(p.id));
      const gross = useFormula ? f.grossTaxable + grossFromNet(f.grossNet, cum + f.grossTaxable, scale)
        : taxable ? grossFromNet(net, cum, scale) : net;
      grossOfPeriod.set(p.id, { gross, taxable });
      if (taxable) cum += gross;
      cum += sickPartsFor(p).filter(x => x.payer === 'employer').reduce((n, x) => n + x.gross, 0);
    }
  }

  /* Доход месяца в начисленных суммах: оклад и премии. Подработка, подарки и
     разовые выплаты без налога в средний заработок не входят. Если выплат месяца
     в плане нет или они неполные, берётся «История доходов» — она тоже в gross. */
  const slotsPerYear = new Map();
  for (const s of slots) slotsPerYear.set(Number(s.year), (slotsPerYear.get(Number(s.year)) ?? 0) + 1);
  const periodsByMonth = new Map();
  for (const p of periods) {
    if (p.sick_leave_id) continue;
    if (!p.window_start) continue;
    const key = `${Number(p.window_start.slice(0, 4))}-${Number(p.window_start.slice(5, 7))}`;
    if (!periodsByMonth.has(key)) periodsByMonth.set(key, []);
    periodsByMonth.get(key).push(p);
  }
  /* В средний заработок идёт то, что платит этот работодатель: оклад по графику
     и премии. Подработка и подарки — нет, даже если облагаются налогом. */
  const inAverage = p => !p.sick_leave_id && p.taxable !== false
    && (p.calc_mode !== 'manual' || p.manual_kind === 'bonus');
  function monthGross(y, m) {
    const key = `${y}-${m}`;
    const list = periodsByMonth.get(key) ?? [];
    const need = slotsPerYear.get(y) ?? 0;
    const sum = list.filter(inAverage).reduce((s, p) => s + (grossOfPeriod.get(p.id)?.gross ?? 0), 0);
    if (list.length && (need === 0 || list.length >= need)) return sum;
    if (history.has(key)) return Number(history.get(key).amount) || 0;
    return sum;
  }

  /* Доход месяца на руки — для подсказок и истории */
  function monthIncome(y, m) {
    const key = `${y}-${m}`;
    const list = periodsByMonth.get(key) ?? [];
    return list.filter(p => !p.sick_leave_id).reduce((s, p) => s + (rowsById.get(p.id)?.salary ?? (Number(p.income_net) || 0)), 0);
  }

  /* 3. Отпускные: формула, сумма в плане, деление по выплатам */
  const avgDaysInMonth = Number(cfg.get('avg_days_in_month'));
  const vacationInfo = vacations.map(v => {
    const formula = vacationFormula(v, { monthGross, rates, sickLeaves, vacations, avgDaysInMonth }, round);
    const pay = vacationPay(v, formula);
    return {
      vacation: v,
      formula,
      pay,
      payDate: v.start_date ? calendar.workingDayBefore(v.start_date) : null,
      split: splitVacationPay(v, pay, periods.filter(p => !p.sick_leave_id)),
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
    const target = [...periods].reverse().find(p => !p.sick_leave_id && p.pay_date <= e.date);
    if (!target) { warnings.push({ code: 'extra_before_plan', extra_income_id: e.id }); continue; }
    if (!extrasByPeriod.has(target.id)) extrasByPeriod.set(target.id, []);
    extrasByPeriod.get(target.id).push({ extra_income_id: e.id, amount });
  }

  /* 5. Налог нарастающим итогом за год даты выплаты и итог выплаты */
  let cum = 0;
  let cumYear = null;
  const sfrCumulative = new Map();
  const rows = periods.map(p => {
    const payYear = Number(p.pay_date.slice(0, 4));
    if (payYear !== cumYear) { cum = 0; cumYear = payYear; }
    const scale = scaleForYear(scales, brackets, payYear);

    if (p.sick_leave_id) {
      const leave = sickLeaves.find(s => s.id === p.sick_leave_id);
      const payer = p.sick_payer;
      const gross = Number(p.sick_gross) || 0;
      const before = payer === 'sfr' ? Math.max(sfrCumulative.get(payYear) ?? 0, Number(leave?.sfr_prior_tax_base) || 0) : cum;
      const manualNet = leave?.[`${payer}_net`];
      const hasManual = manualNet !== null && manualNet !== undefined && manualNet !== '';
      const net = p.locked ? Number(p.income_net) || 0 : hasManual ? Math.max(0, Number(manualNet) || 0)
        : gross - taxForPayment(gross, before, scale);
      if (!scale && !p.locked && !hasManual) warnings.push({ code: 'sick_no_tax_scale', sick_leave_id: leave?.id });
      const paidNet = !scale && !p.locked && !hasManual ? 0 : net;
      if (payer === 'sfr') sfrCumulative.set(payYear, before + gross); else cum += gross;
      return { period: p, formula: null, salary: paidNet, sick: { leave, payer, gross, manual: hasManual, pendingTax: !scale && !p.locked && !hasManual },
        vacationPay: 0, vacationGross: 0, vacationTax: 0, vacations: [], extraIncome: 0, extras: [],
        gross, tax: gross - paidNet, taxParts: taxParts(gross, before, scale), total: paidNet };
    }

    const g = formulaGross.get(p.id);
    let formula = null;
    if (g) {
      const tax = taxForPayment(g.grossTaxable, cum, scale, round);
      formula = { ...g, tax, net: g.gross - tax };
    } else if (p.calc_mode !== 'manual') {
      warnings.push({ code: 'no_salary_rate', period_id: p.id });
    }

    const useFormula = formula && (automaticIncome(p) || fillIds?.has(p.id));
    const salary = useFormula ? formula.net : (Number(p.income_net) || 0);
    const cumBefore = cum;
    // разовая выплата без галочки «облагается налогом» в годовой доход не входит
    const taxable = p.taxable !== false;
    const salaryGross = !taxable ? salary : (useFormula ? formula.grossTaxable : grossFromNet(salary, cum, scale));
    cum += taxable ? salaryGross : 0;

    /* Отпускные приходят уже начисленными: налог с них считается здесь,
       в план идёт сумма на руки. */
    const vac = vacationByPeriod.get(p.id) ?? [];
    const vacationGross = vac.reduce((s, x) => s + x.amount, 0);
    const vacationTax = vacationGross > 0 ? taxForPayment(vacationGross, cum, scale, round) : 0;
    const vacationPayTotal = round(vacationGross - vacationTax);
    cum += vacationGross;

    const sickParts = sickPartsFor(p).map(part => {
      const leave = sickLeaves.find(s => s.id === part.leave_id);
      const before = part.payer === 'sfr' ? Math.max(sfrCumulative.get(payYear) ?? 0, Number(leave?.sfr_prior_tax_base) || 0) : cum;
      const frozen = p.locked && Array.isArray(p.sick_snapshot);
      const manual = part.manualNet !== null && part.manualNet !== undefined;
      const pendingTax = !frozen && !scale && !manual;
      const net = frozen ? part.net : manual ? part.manualNet : pendingTax ? 0 : part.gross - taxForPayment(part.gross, before, scale);
      if (pendingTax) warnings.push({ code: 'sick_no_tax_scale', sick_leave_id: part.leave_id });
      if (part.payer === 'sfr') sfrCumulative.set(payYear, before + part.gross); else cum += part.gross;
      return { ...part, net, tax: part.gross - net, manual, pendingTax,
        taxParts: frozen ? part.taxParts ?? [] : taxParts(part.gross, before, scale) };
    });
    const sickGross = sickParts.reduce((n, x) => n + x.gross, 0);
    const sickPay = sickParts.reduce((n, x) => n + x.net, 0);
    const sickTax = sickParts.reduce((n, x) => n + x.tax, 0);

    // сколько начислено и удержано в этой выплате — для истории доходов на обзоре
    const gross = round(salaryGross + vacationGross) + sickGross;
    const parts_ = [...taxParts((taxable ? salaryGross : 0) + vacationGross, cumBefore, scale, round), ...sickParts.flatMap(x => x.taxParts)];
    const tax = Math.max(0, round(gross - sickGross - salary - vacationPayTotal)) + sickTax;

    const extras = extrasByPeriod.get(p.id) ?? [];
    const extraIncome = extras.reduce((s, x) => s + x.amount, 0);

    return {
      period: p,
      formula,
      salary,
      vacationPay: vacationPayTotal,
      vacationGross,
      vacationTax,
      vacations: vac.map(x => ({ ...x, gross: x.amount, net: round(x.amount - (vacationGross > 0 ? vacationTax * x.amount / vacationGross : 0)) })),
      sickPay, sickGross, sickTax, sickParts,
      sickPendingTax: sickParts.some(x => x.pendingTax),
      extraIncome,
      extras,
      gross,
      tax,
      taxParts: parts_,
      total: salary + vacationPayTotal + sickPay + extraIncome,
    };
  });

  const rowsById = new Map(rows.map(r => [r.period.id, r]));

  return {
    calendar,
    preparedPeriods,
    sickLeaves: sickInfo,
    periods: rows,
    byId: rowsById,
    vacations: vacationInfo,
    monthIncome,
    monthGross,
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
  return fresh.map(p => ({ ...p, income_net: result.byId.get(p.id)?.formula?.net ?? 0, income_manual: false }));
}
