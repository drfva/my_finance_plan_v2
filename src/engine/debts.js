/* ---------------------------------------------------------------------
   debts.js — рассрочки и кредитные карты.

   Рассрочки. График платежей (installment_payments) строится один раз при
   создании покупки и дальше правится руками. Периодичность — «каждые every_n
   единиц period_unit» (ref_period_units): день и неделя — в днях, месяц и год —
   календарно, с ограничением дня длиной месяца (31 января + 1 месяц = 28 февраля).
   Платёж оплачивается из последней выплаты не позже его даты: выплаты 05.05 и
   20.05, платёж 07.05 → из выплаты 05.05. Платёж раньше первой выплаты — вне плана.

   Кредитные карты. Трата при нулевом долге открывает льготный период: срок =
   дата траты + grace_days. Следующие траты, пока долг не погашен, срок не
   двигают. Погашение до нуля (остаток ≤ 0,5) закрывает период. Операции карты —
   в валюте карты; платежи из выплат — в базовой, переводятся по курсу.
--------------------------------------------------------------------- */

import { addDays, addMonths, parts, clampDay } from './dates.js';

/* ------------------------------------------------------------------ рассрочки */

/* Дата i-го платежа */
export function nthDate(first, i, everyN, unit, units = []) {
  const n = Math.max(1, Number(everyN) || 1) * i;
  const ref = units.find(u => u.code === unit);
  if (unit === 'day' || unit === 'week' || (ref && ref.days)) {
    const days = ref?.days ?? (unit === 'week' ? 7 : 1);
    return addDays(first, n * days);
  }
  const { y, m, d } = parts(first);
  const months = unit === 'year' ? n * 12 : n;
  const t = addMonths(y, m, months);
  return clampDay(t.y, t.m, d);
}

/* График платежей покупки: сумма делится на части, копейки — первым платежам
   (как в старой версии: 1000 на 3 → 334, 333, 333) */
export function buildInstallmentSchedule(inst, units = []) {
  const parts_ = Math.max(1, Math.round(Number(inst.parts) || 1));
  const total = Math.max(0, Math.round(Number(inst.total) || 0));
  const base = Math.floor(total / parts_);
  const rest = total - base * parts_;
  const out = [];
  for (let i = 0; i < parts_; i++) {
    out.push({
      id: `${inst.id}-${i + 1}`,
      installment_id: inst.id,
      pay_date: inst.first_date ? nthDate(inst.first_date, i, inst.every_n, inst.period_unit, units) : null,
      amount: base + (i < rest ? 1 : 0),
      paid: false,
      sort_order: i + 1,
    });
  }
  return out;
}

/* Пересобрать график на будущие даты: прошедшие платежи остаются как есть,
   остаток суммы делится между оставшимися частями по тем же правилам. */
export function rebuildFuture(inst, payments, today, units = []) {
  const own = payments.filter(p => p.installment_id === inst.id);
  const past = own.filter(p => p.pay_date && p.pay_date <= today)
    .sort((a, b) => (a.pay_date < b.pay_date ? -1 : 1));
  const total = Math.max(0, Math.round(Number(inst.total) || 0));
  const parts = Math.max(1, Math.round(Number(inst.parts) || 1));
  const paid = past.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const left = Math.max(0, total - paid);
  const partsLeft = Math.max(0, parts - past.length);
  if (!partsLeft) return [...past];
  const base = Math.floor(left / partsLeft);
  const rest = left - base * partsLeft;
  const out = [...past];
  for (let k = 0; k < partsLeft; k++) {
    const i = past.length + k;
    out.push({
      id: `${inst.id}-${i + 1}`,
      installment_id: inst.id,
      pay_date: inst.first_date ? nthDate(inst.first_date, i, inst.every_n, inst.period_unit, units) : null,
      amount: base + (k < rest ? 1 : 0),
      paid: false,
      sort_order: i + 1,
    });
  }
  return out;
}

/* Платежи по выплатам: Map period_id → [{ date, amount, installments: [id...] }] */
export function installmentsByPeriod(installments, payments, periods) {
  const sorted = [...periods].sort((a, b) => (a.pay_date < b.pay_date ? -1 : a.pay_date > b.pay_date ? 1 : 0));
  const names = new Map(installments.map(i => [i.id, i.title]));
  const map = new Map();
  const outside = [];
  for (const pay of payments) {
    const amount = Number(pay.amount) || 0;
    if (!pay.pay_date || !(amount > 0) || !names.has(pay.installment_id)) continue;
    let target = null;
    for (const p of sorted) { if (p.pay_date <= pay.pay_date) target = p; else break; }
    if (!target) { outside.push(pay); continue; }
    if (!map.has(target.id)) map.set(target.id, []);
    const list = map.get(target.id);
    let same = list.find(x => x.date === pay.pay_date);
    if (!same) { same = { date: pay.pay_date, amount: 0, installments: [] }; list.push(same); }
    same.amount += amount;
    if (!same.installments.includes(pay.installment_id)) same.installments.push(pay.installment_id);
  }
  for (const list of map.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { byPeriod: map, outside };
}

/* ------------------------------------------------------------------ карты */

export function newCardState() {
  return { debt: 0, cycleStart: null, deadline: null };
}

export function sortedCardOps(ops, cardId) {
  return ops
    .filter(o => o.card_id === cardId && o.op_date)
    .sort((a, b) => (a.op_date !== b.op_date
      ? (a.op_date < b.op_date ? -1 : 1)
      : (a.kind === 'spend' ? 0 : 1) - (b.kind === 'spend' ? 0 : 1)));
}

export function cardApplyPayment(cs, amount, date, cycles) {
  if (!amount) return;
  cs.debt -= amount;
  if (cs.debt <= 0.5) {
    cs.debt = 0;
    if (cs.cycleStart && cycles) {
      const c = cycles.find(x => x.start === cs.cycleStart && !x.closed);
      if (c) c.closed = date;
    }
    cs.cycleStart = null;
    cs.deadline = null;
  }
}

export function cardApplyOp(cs, card, op, cycles) {
  const amount = Math.abs(Number(op.amount) || 0);
  if (!amount) return;
  if (op.kind === 'payment') { cardApplyPayment(cs, amount, op.op_date, cycles); return; }
  if (cs.debt <= 0.5) {
    cs.debt = 0;
    cs.cycleStart = op.op_date;
    const grace = card.grace_days !== null && card.grace_days !== undefined && !Number.isNaN(Number(card.grace_days))
      ? Number(card.grace_days) : 60;
    cs.deadline = addDays(op.op_date, grace);
    if (cycles) cycles.push({ start: cs.cycleStart, deadline: cs.deadline, closed: null });
  }
  cs.debt += amount;
}

/* Статус льготного периода: в срок, позже срока, за пределами плана, не погашен */
export function cycleStatus(cycle, planEnd) {
  if (cycle.closed) return cycle.closed <= cycle.deadline ? 'on_time' : 'late';
  if (planEnd && cycle.deadline > planEnd) return 'beyond_plan';
  return 'unpaid';
}
