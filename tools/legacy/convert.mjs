// Старое состояние → состояние v2 (как его отдаёт state_get). Прообраз скрипта переноса этапа 6.
const pad = n => String(n).padStart(2, '0');
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function toV2(st, ref) {
  const d = st.debts || {};
  const years = [...new Set(st.periods.map(p => p.monthRef.y))];
  const slots = years.flatMap(year => [
    { year, sort_order: 1, title: 'Аванс', pay_day: 20, month_offset: 0, window_from_day: 1, window_to_day: 15, shift_rule: 'back' },
    { year, sort_order: 2, title: 'Зарплата', pay_day: 5, month_offset: 1, window_from_day: 16, window_to_day: 31, shift_rule: 'back' },
  ]);
  const periods = st.periods.map(p => {
    const { y, m } = p.monthRef;
    const first = p.half === 'first';
    return {
      id: p.id, year: y, slot_order: p.half === 'full' ? null : (first ? 1 : 2), title: '',
      pay_date: p.date,
      window_start: `${y}-${pad(m)}-${first || p.half === 'full' ? '01' : '16'}`,
      window_end: `${y}-${pad(m)}-${first ? '15' : pad(dim(y, m))}`,
      calc_mode: p.calc, income_net: p.incomeActual || 0, note: p.note || '', locked: !!p.locked,
    };
  });
  const kinds = d.goalSettings || {};
  const goals = st.goals.map(g => ({
    id: g.id, title: g.name, kind_code: kinds[g.id]?.kind || 'bucket', currency_code: 'RUB', priority: g.priority,
    target_amount: g.target || 0, deadline: g.deadline || null, starting_balance: g.startingBalance || 0,
    pace_amount: kinds[g.id]?.pace || 0, completed: !!g.completed,
  }));
  const goal_milestones = st.goals.flatMap(g => (g.subgoals || []).map((s, i) => ({
    id: s.id, goal_id: g.id, title: s.name, target: s.target, deadline: s.deadline || null, source: 'manual', source_ref: null,
    occurrence_key: null, user_edited: false, sort_order: i })));
  const goal_transactions = st.goals.flatMap(g => (g.withdrawals || []).map((w, i) => ({
    id: `${g.id}-w${i}`, goal_id: g.id, date: w.date, amount: Math.abs(w.amount), kind: w.amount >= 0 ? 'spend' : 'transfer_in',
    title: w.note || '', counterparty_id: null, milestone_id: null, source: 'manual', occurrence_key: null, user_edited: false })));
  const flat = (obj, a, b) => Object.entries(obj || {}).flatMap(([pid, m]) => Object.entries(m).map(([id, amount]) => ({ period_id: pid, [a]: id, amount })));
  return {
    ref,
    user: { settings: {} },
    account: { id: 'acc', can_edit: true, role: 'owner' },
    settings: {
      account_settings: {},
      allocation_rules: [
        { stage_code: 'categories', priority: 1, enabled: true, params: {} },
        { stage_code: 'installments', priority: 2, enabled: true, params: {} },
        { stage_code: 'credits', priority: 3, enabled: true, params: {} },
        { stage_code: 'gifts', priority: 4, enabled: true, params: {} },
        { stage_code: 'buckets', priority: 5, enabled: true, params: {} },
        { stage_code: 'reserves', priority: 6, enabled: true, params: {} },
      ],
      fx_rates: [],
    },
    income: {
      plan_years: years.map(year => ({ year })), payout_slots: slots,
      salary_rates: st.oklad.history.map((h, i) => ({ id: 'r' + i, effective_from: h.effectiveFrom, amount: h.amount, is_gross: true })),
      tax_scales: [{ id: 'ndfl', valid_from_year: 2000, cumulative: true }],
      tax_brackets: st.ndfl.brackets.map((b, i) => ({ scale_id: 'ndfl', sort_order: i + 1, up_to: b.upTo, rate: b.rate * 100 })),
      periods,
      income_history: (st.income2026 || []).map((a, i) => ({ year: 2026, month: i + 1, amount: a })),
      vacations: st.vacations.map(v => ({ id: v.id, title: v.note || '', start_date: v.start, end_date: v.end, pay_amount: v.manualPay || 0, pay_manual: true })),
      sick_leaves: (st.sickLeaves || []).map(s => ({ id: s.id, start_date: s.start, end_date: s.end, note: s.note || '' })),
      extra_incomes: [],
      account_calendar_days: (st.meta.holidays || []).map(date => ({ date, kind: 'holiday', title: '' })),
      working_day_overrides: [],
    },
    expenses: {
      expense_categories: st.categories.map((c, i) => ({
        id: c.id, title: c.name, mode: 'fixed_month', monthly_amount: (c.amount || 0) * 2, percent_value: 0, split_mode: 'even',
        season_from: c.season?.from || null, season_to: c.season?.to || null, sort_order: i })),
      expense_items: st.categories.flatMap(c => (c.items || []).map((it, i) => ({
        id: `${c.id}-i${i}`, category_id: c.id, title: it.name, amount: (it.amount || 0) * 2,
        season_from: it.season?.from || null, season_to: it.season?.to || null, sort_order: i }))),
      expense_period_overrides: flat(st.categoryOverrides, 'category_id'),
    },
    debts: {
      credit_cards: (d.cards || []).map((c, i) => ({ id: c.id, title: c.name, credit_limit: c.limit || 0, grace_days: c.graceDays ?? 60, currency_code: 'RUB', sort_order: i })),
      credit_card_ops: (d.cards || []).flatMap(c => (c.ops || []).map(o => ({ id: o.id, card_id: c.id, op_date: o.date, amount: o.amount, kind: o.kind, title: o.note || '' }))),
      credit_payment_overrides: flat(d.paymentOverrides, 'card_id'),
      installments: (d.installments || []).map(i => ({ id: i.id, title: i.name, total: i.total, parts: i.parts, every_n: i.interval === '1m' ? 1 : 2, period_unit: i.interval === '1m' ? 'month' : 'week', first_date: i.firstDate })),
      installment_payments: (d.installments || []).flatMap(i => (i.payments || []).map((p, k) => ({ id: p.id, installment_id: i.id, pay_date: p.date, amount: p.amount, paid: false, sort_order: k }))),
    },
    savings: { goals, goal_milestones, goal_transactions, goal_cycles: [], goal_cycle_skips: [], savings_period_overrides: flat(st.savingsOverrides, 'goal_id') },
    gifts: { gift_events: [], gift_event_amounts: [] },
    facts: { expense_facts: [] },
  };
}
