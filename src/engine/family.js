/* Чистый расчёт взносов. Проведение выполняет сервер отдельно от simulate().
   В family_private находятся только собственное правило и собственная история. */
import { addMonths, isValid } from './dates.js';

const clone = x => JSON.parse(JSON.stringify(x));
const positive = x => Math.max(0, Number(x) || 0);
const cash = value => Math.round((Number(value) || 0) * 100) / 100;
const cashFloor = value => Math.floor((Number(value) || 0) * 100 + 1e-7) / 100;
export const familyToday = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',
}).format(date);
const ym = date => date.slice(0, 7);
const nextMonth = month => {
  const { y, m } = addMonths(...month.split('-').map(Number), 1);
  return `${y}-${String(m).padStart(2, '0')}`;
};

export function validateFamilyRule(rule) {
  if (!['per_payment', 'monthly', 'percent', 'remainder'].includes(rule.mode)) throw new Error('Выберите способ отчислений');
  if (!isValid(rule.effective_from)) throw new Error('Укажите дату начала правила');
  for (const key of ['amount', 'percent', 'limit_amount', 'limit_percent', 'cap_per_payment']) {
    if (rule[key] != null && (!Number.isFinite(Number(rule[key])) || Number(rule[key]) < 0)) throw new Error('Суммы и проценты должны быть неотрицательными');
  }
  for (const key of ['percent', 'limit_percent']) if (Number(rule[key]) > 100) throw new Error('Процент должен быть от 0 до 100');
  if (rule.limit_scope != null && !['payment', 'month'].includes(rule.limit_scope)) throw new Error('Неверный период лимита');
  return true;
}

export function createFamilyAllocator({ state, income, reference = null, round = Math.round }) {
  const own = state.family_private ?? {};
  const member = own.membership;
  const posted = new Map((own.contributions ?? []).map(c => [c.period_id, c]));
  const overrides = new Map((own.overrides ?? []).filter(o=>o.amount!=null).map(o => [o.period_id,positive(o.amount)]));
  const rules = (own.rules ?? []).slice().sort((a, b) => a.effective_from.localeCompare(b.effective_from) || (a.revision ?? 0) - (b.revision ?? 0));
  const ruleAt = date => rules.filter(r => r.effective_from <= date).at(-1);
  const eligible = p => member?.active && member.source_account_id === state.account?.id && !p.locked && !posted.has(p.id) && ruleAt(p.pay_date);
  const rows = income.periods.filter(r => eligible(r.period));
  let ledger = { obligations: [], monthly_paid: {}, limit_paid: {}, through_month: null };
  const totalDebt = () => cash(ledger.obligations.reduce((s, x) => s + x.remaining, 0));
  const accrueMonths = date => {
    if (!rules.length) return;
    const end = ym(date);
    let month = ledger.through_month || ym(rules[0].effective_from);
    for (; month <= end; month = nextMonth(month)) {
      const rule = ruleAt(month === end ? date : `${month}-31`);
      const key=`monthly:${month}`, obligation=ledger.obligations.find(o=>o.key===key);
      if (rule?.mode === 'monthly') {
        const amount=positive(round(positive(rule.amount))),paid=positive(ledger.monthly_paid[month]);
        if (obligation) Object.assign(obligation,{amount,remaining:Math.max(0,cash(amount-paid)),cancelled:false});
        else ledger.obligations.push({key,month,amount,remaining:Math.max(0,cash(amount-paid))});
        // При переходе на месячный план текущие обязательства входят в общий
        // остаток месяца, а не начисляются второй раз поверх новой суммы.
        for (const o of ledger.obligations) if(o.month===month&&o.key!==key){o.remaining=0;o.rolled_into=key;}
      } else if (obligation) {
        // Смена режима отменяет неоплаченную часть только своего месяца.
        obligation.remaining=0;obligation.cancelled=true;
      }
      ledger.through_month = month;
    }
  };

  function step(period, available, { enabled = true } = {}) {
    const fixed = posted.get(period.id);
    if (fixed) {
      if (fixed.member_id === member?.id && fixed.ledger_after) ledger = clone(fixed.ledger_after);
      return { ...fixed, outstanding: (fixed.ledger_after?.obligations ?? []).reduce((sum, o) => sum + positive(o.remaining), 0), posted: fixed.status !== 'forecast' };
    }
    const empty = { amount: 0, current_amount: 0, arrears_amount: 0, settlements: [], outstanding: totalDebt(), posted: false };
    if (!enabled || !eligible(period)) return empty;
    const date = period.pay_date, month = ym(date), rule = ruleAt(date);
    const I = positive(income.byId.get(period.id)?.total), S = positive(available);
    accrueMonths(date);
    let currentKey = `payment:${period.id}`, need = 0;
    if (rule.mode === 'monthly') {
      currentKey = `monthly:${month}`;
      const outstanding = ledger.obligations.find(o => o.key === currentKey)?.remaining ?? 0;
      const futureIncome = rows.filter(r => ym(r.period.pay_date) === month && (r.period.pay_date > date || r.period.pay_date === date && String(r.period.id) >= String(period.id)))
        .reduce((s, r) => s + positive(r.total), 0);
      need = futureIncome > 0 ? Math.min(outstanding, positive(round(outstanding * I / futureIncome))) : 0;
    } else if (rule.mode !== 'remainder') {
      need = positive(round(rule.mode === 'percent' ? I * positive(rule.percent) / 100 : positive(rule.amount)));
      ledger.obligations.push({ key: currentKey, month, amount: need, remaining: need });
    }
    const old = ledger.obligations.filter(o => o.key !== currentKey).reduce((s, o) => s + o.remaining, 0);
    let cap = rule.cap_per_payment == null ? Infinity : positive(rule.cap_per_payment);
    let limitExceeded = 0;
    if (rule.mode === 'remainder') {
      need = S;
      const monthly = rule.limit_scope === 'month';
      const paid = monthly ? positive(ledger.limit_paid[month]) : 0;
      if (rule.limit_amount != null) cap = Math.min(cap, Math.max(0, positive(rule.limit_amount) - paid));
      if (rule.limit_percent != null) {
        // Месячная база — остатки на позиции семейного этапа, а не доходы.
        const base = monthly ? income.periods.filter(r => ym(r.period.pay_date) === month).reduce((sum, r) => {
          if (r.period.id === period.id) return sum + S;
          const p = posted.get(r.period.id);
          if (p?.member_id === member.id) return sum + positive(p.available_before);
          return sum + (eligible(r.period) ? positive(reference?.byId.get(r.period.id)?.familyContribution?.available_before ?? r.total) : 0);
        }, 0) : S;
        const ceiling = positive(round(base * positive(rule.limit_percent) / 100));
        cap = Math.min(cap, Math.max(0, ceiling - paid));
        limitExceeded = Math.max(0, paid - ceiling);
      }
    }
    const requested=overrides.has(period.id)?overrides.get(period.id):null;
    let amount = cashFloor(Math.min(S, cap, positive(round(requested ?? old + need))));
    // Сначала самый ранний обязательный недобор; остаточный режим новых долгов не создаёт.
    const settlements = [];
    let left = amount;
    for (const o of ledger.obligations.filter(o => o.key !== currentKey).concat(ledger.obligations.filter(o => o.key === currentKey))) {
      const value = cash(Math.min(left, o.remaining));
      if (value > 0) {
        o.remaining = cash(o.remaining - value); left = cash(left - value);
        settlements.push({ key: o.key, month: o.month, amount: value });
        ledger.monthly_paid[o.month] = cash(positive(ledger.monthly_paid[o.month]) + value);
      }
    }
    if (rule.mode !== 'remainder' && requested === null) amount = cash(amount - left);
    else if(left>0) ledger.monthly_paid[month]=cash(positive(ledger.monthly_paid[month])+left);
    ledger.limit_paid[month] = cash(positive(ledger.limit_paid[month]) + amount);
    const arrears = cash(settlements.filter(o => o.month < month).reduce((s, o) => s + o.amount, 0));
    return { member_id: member.id, family_id: member.family_id, period_id: period.id, pay_date: date,
      amount, current_amount: cash(amount - arrears), arrears_amount: arrears, settlements,
      available_before: S, outstanding: totalDebt(), limit_exceeded: limitExceeded,
      manual: requested !== null, requested_amount: requested,
      ledger_after: clone(ledger), posted: false };
  }
  return { step, posted, ruleAt };
}

/* Месячные бюджеты независимы. Статистический факт не участвует в остатке. */
export function familyBudget(family, month) {
  const calculated = family.budget?.months?.find(m => m.month === month);
  if (calculated) return { ...calculated,
    balance: cash(calculated.received - calculated.planned),
    forecastBalance: cash(calculated.expected - calculated.planned),
    deviation: cash(calculated.actual - calculated.planned) };
  const list = (family.contributions ?? []).filter(c => c.pay_date?.startsWith(month));
  const sum=rows=>cash(rows.reduce((s,r)=>s+positive(r.amount),0));
  const received = sum(list.filter(c => c.status === 'posted'));
  const future = sum(list.filter(c => c.status === 'forecast'));
  const planned = sum((family.monthly_expenses ?? []).filter(e => e.month === month));
  const actual = sum((family.expense_facts ?? []).filter(e => e.month === month));
  return { received, future, expected: cash(received + future), planned, actual,
    balance: cash(received - planned), forecastBalance: cash(received + future - planned), deviation: cash(actual - planned) };
}

export function familyYearBudget(family, year) {
  const months = Array.from({length:12},(_,i) => familyBudget(family,`${year}-${String(i+1).padStart(2,'0')}`));
  return Object.fromEntries(['received','future','expected','planned','actual','balance','forecastBalance','deviation','unassigned']
    .map(key => [key,cash(months.reduce((sum,m) => sum + (Number(m[key]) || 0),0))]));
}
