/* График договора хранится отдельно от платежей из выплат. Досрочные суммы
   уменьшают ближайшие будущие части; снимки фиксируют проведённую историю. */
export function createInstallmentAllocator(installments, payments, periods) {
  const sorted = [...periods].sort((a,b) => a.pay_date.localeCompare(b.pay_date));
  const known = new Set(installments.map(i => i.id));
  const entries = new Map();
  const outside = [];
  for (const payment of payments) {
    if (!known.has(payment.installment_id) || !payment.pay_date || !(Number(payment.amount) > 0)) continue;
    const target = sorted.filter(p => p.pay_date <= payment.pay_date).at(-1);
    if (!target) outside.push(payment);
    entries.set(payment.id, { ...payment, remaining: Number(payment.amount), target: target?.id, allocations: [] });
  }
  const reserved = new Map();
  const snapshots = new Map();
  for (const period of sorted) if (period.locked) {
    const snapshot = Array.isArray(period.installment_snapshot) ? period.installment_snapshot
      : [...entries.values()].filter(e => e.target === period.id).map(e => ({ payment_id:e.id,installment_id:e.installment_id,date:e.pay_date,amount:Number(e.amount),early:false }));
    snapshots.set(period.id,snapshot);
    for (const detail of snapshot) reserved.set(detail.payment_id, (reserved.get(detail.payment_id) ?? 0) + detail.amount);
  }
  // Если график пересоздали с другими id, проведённые деньги остаются зачётом
  // этой рассрочки. Резервируем их до прогноза новых досрочных платежей.
  const reassigned = new Map();
  for (const period of sorted) for (const detail of snapshots.get(period.id) ?? []) if (!entries.has(detail.payment_id)) {
    let left = detail.amount;
    const targets = [];
    for (const entry of [...entries.values()].filter(e => e.installment_id === detail.installment_id && e.pay_date >= period.pay_date)
      .sort((a,b) => a.pay_date.localeCompare(b.pay_date) || a.id.localeCompare(b.id))) {
      const amount = Math.min(left,Math.max(0,entry.remaining-(reserved.get(entry.id)??0)));
      if (amount <= 0) continue;
      targets.push({ id:entry.id,amount }); reserved.set(entry.id,(reserved.get(entry.id)??0)+amount); left -= amount;
      if (left <= 0) break;
    }
    reassigned.set(detail,targets);
  }
  const rowDetails = new Map();
  function record(period, detail) {
    const list = rowDetails.get(period.id) ?? [];
    list.push({ ...detail }); rowDetails.set(period.id, list);
    const targets = entries.has(detail.payment_id) ? [{id:detail.payment_id,amount:detail.amount}] : (reassigned.get(detail) ?? []);
    for (const target of targets) {
      const entry = entries.get(target.id);
      entry.remaining = Math.max(0, entry.remaining - target.amount);
      entry.allocations.push({ ...detail, amount:target.amount, period_id: period.id, pay_date: period.pay_date, locked: Boolean(period.locked) });
    }
  }
  function step(period) {
    if (period.locked) {
      for (const detail of snapshots.get(period.id)) {
        reserved.set(detail.payment_id, Math.max(0, (reserved.get(detail.payment_id) ?? 0) - detail.amount));
        for (const target of reassigned.get(detail) ?? []) reserved.set(target.id,Math.max(0,(reserved.get(target.id)??0)-target.amount));
        record(period, detail);
      }
    } else {
      for (const entry of entries.values()) if (entry.target === period.id) {
        const amount = Math.max(0, entry.remaining - (reserved.get(entry.id) ?? 0));
        if (amount > 0) record(period, { payment_id: entry.id, installment_id: entry.installment_id, date: entry.pay_date, amount, early: false });
      }
    }
    return details(period);
  }
  function prepay(period, available) {
    let spent = 0;
    const index = sorted.findIndex(p => p.id === period.id);
    const future = [...entries.values()].filter(e => e.target && sorted.findIndex(p => p.id === e.target) > index)
      .sort((a,b) => a.pay_date.localeCompare(b.pay_date) || (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
    for (const entry of future) {
      const amount = Math.min(Math.max(0, available - spent), Math.max(0, entry.remaining - (reserved.get(entry.id) ?? 0)));
      if (amount <= 0) continue;
      record(period, { payment_id: entry.id, installment_id: entry.installment_id, date: entry.pay_date, amount, early: true });
      spent += amount;
      if (spent >= available) break;
    }
    return spent;
  }
  const details = period => rowDetails.get(period.id) ?? [];
  function groups(period) {
    const result = [];
    for (const detail of details(period)) {
      let group = result.find(g => g.date === detail.date && Boolean(g.early) === Boolean(detail.early));
      if (!group) { group = { date: detail.date, amount: 0, installments: [], ...(detail.early ? { early: true } : {}) }; result.push(group); }
      group.amount += detail.amount;
      if (!group.installments.includes(detail.installment_id)) group.installments.push(detail.installment_id);
    }
    return result.sort((a,b) => a.date.localeCompare(b.date));
  }
  return { outside, step, prepay, details, groups, schedule: () => [...entries.values()] };
}
