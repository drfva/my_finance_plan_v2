/* Сводка из текущего расчёта, без сохранённого кеша. Выплаты графика относятся
   к своему расчётному месяцу; разовые — к дате поступления. Реальные даты
   отпускных/больничного — отдельная справка, не второе зачисление дохода. */
import { isSalaryPeriod } from './salary.js';
import { isValid } from './dates.js';

const bucket = () => ({ net: 0, gross: 0, tax: 0, rates: new Map(), manualTax: false });
const add = (to, from) => {
  for (const key of ['net', 'gross', 'tax']) to[key] += Number(from[key]) || 0;
  for (const p of from.parts ?? []) to.rates.set(p.rate, (to.rates.get(p.rate) ?? 0) + p.amount);
  if (from.rates) for (const [rate, amount] of from.rates) to.rates.set(rate, (to.rates.get(rate) ?? 0) + amount);
  to.manualTax ||= Boolean(from.manualTax);
};
const monthBucket = month => ({ month, slots: new Map(), automatic: bucket(), oneOff: bucket(),
  vacation: bucket(), sick: bucket(), missingSickDates: 0 });

export function buildIncomeReport({ state, income, year }) {
  const months = new Map(Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    return [month, monthBucket(month)];
  }));
  const get = date => months.get(String(date ?? '').slice(0, 7));
  const configured = (state.income?.payout_slots ?? []).filter(s => Number(s.year) === year)
    .sort((a, b) => a.sort_order - b.sort_order);
  const slots = new Map(configured.map(s => [String(s.sort_order), { key: String(s.sort_order), title: s.title || `Выплата ${s.sort_order}` }]));
  const extras = new Map((state.income?.extra_incomes ?? []).map(e => [e.id, e]));
  const leaves = new Map((state.income?.sick_leaves ?? []).map(s => [s.id, s]));
  const vacationParts = new Map(), sickParts = new Map();
  let hasData = configured.length > 0;

  for (const r of income.periods) {
    const p = r.period;
    if (isSalaryPeriod(p) && Number(p.year) === year) {
      const key = String(p.slot_order ?? 'other');
      if (!slots.has(key)) slots.set(key, { key, title: p.title || (p.slot_order ? `Выплата ${p.slot_order}` : 'Выплата по графику') });
      const m = get(p.window_start || p.pay_date);
      if (m) {
        const net = r.salary + (r.vacationPay ?? 0) + (r.sickPay ?? 0);
        m.slots.set(key, (m.slots.get(key) ?? 0) + net);
        add(m.automatic, { net, gross: r.gross, tax: r.tax, parts: r.taxParts,
          manualTax: r.sickParts?.some(x => x.manual) });
        hasData = true;
      }
    } else if (!isSalaryPeriod(p)) {
      const m = get(p.pay_date);
      if (m) { add(m.oneOff, { net: r.salary, gross: r.gross, tax: r.tax, parts: r.taxParts }); hasData = true; }
    }
    // Старые разовые доходы, прикреплённые к выплате, остаются разовыми в сводке.
    for (const e of r.extras ?? []) {
      const m = get(extras.get(e.extra_income_id)?.date || p.pay_date);
      if (m) { add(m.oneOff, { net: e.amount, gross: e.amount }); hasData = true; }
    }
    for (const v of r.vacations ?? []) {
      if (!vacationParts.has(v.vacation_id)) vacationParts.set(v.vacation_id, bucket());
      add(vacationParts.get(v.vacation_id), { net: v.net, gross: v.gross, tax: v.gross - v.net });
    }
    const parts = r.sick ? [{ leave_id: p.sick_leave_id, payer: p.sick_payer, gross: r.gross, net: r.salary }] : r.sickParts ?? [];
    for (const s of parts) {
      const key = `${s.leave_id}|${s.payer}`;
      if (!sickParts.has(key)) sickParts.set(key, { leave_id: s.leave_id, payer: s.payer, ...bucket() });
      add(sickParts.get(key), { net: s.net, gross: s.gross, tax: s.gross - s.net });
      if (!isValid(leaves.get(s.leave_id)?.[`${s.payer}_pay_date`])) {
        const m = get(p.window_start || p.pay_date);
        if (m && Number(p.year) === year) m.missingSickDates += s.net;
      }
    }
  }
  for (const v of income.vacations ?? []) {
    const m = get(v.payDate), values = vacationParts.get(v.vacation.id);
    if (m && values) { add(m.vacation, values); hasData = true; }
  }
  for (const s of sickParts.values()) {
    const m = get(leaves.get(s.leave_id)?.[`${s.payer}_pay_date`]);
    if (m) { add(m.sick, s); hasData = true; }
  }
  const totals = monthBucket('year');
  for (const m of months.values()) {
    for (const [key, value] of m.slots) totals.slots.set(key, (totals.slots.get(key) ?? 0) + value);
    for (const key of ['automatic', 'oneOff', 'vacation', 'sick']) add(totals[key], m[key]);
    totals.missingSickDates += m.missingSickDates;
  }
  return { slots: [...slots.values()], months: hasData ? [...months.values()] : [], totals };
}
