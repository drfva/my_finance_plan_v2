/* ---------------------------------------------------------------------
   expenses.js — план расходов каждой выплаты.

   Категория (expense_categories) задаёт сумму НА МЕСЯЦ и режим:
   * fixed_month — сумма месяца делится между выплатами этого месяца:
       even    — поровну;
       by_days — пропорционально длине расчётного периода выплаты.
     Остаток от округления уходит в последнюю выплату месяца, чтобы за месяц
     выходила ровно сумма категории.
   * percent_income — заданный percent_value от каждой выплаты. Если есть
     подкатегории, процент складывается из их действующих percent_value. Например, 10 %
     от выплаты 1 000 — это 100. Суммы и статьи других категорий на процент не
     влияют; monthly_amount и денежные сезоны этой категории не используются.
     План месяца — сумма рассчитанных процентов, с ней сравниваются ручные
     правки выплат (monthChecks). Вне периода действия категории процент — 0.

   Месяц выплаты — месяц начала её расчётного периода: аванс за 01–15 марта и
   зарплата за 16–31 марта (которую платят 5 апреля) делят расходы марта.
   Сумму месяца делят только выплаты по графику (со slot_order), доля каждой —
   от всех выплат графика за месяц. Разовые ручные выплаты (премия) расходы
   месяца на себя не берут; если за месяц нет ни одной выплаты по графику, сумму
   делят ручные.

   Статьи (expense_items) со своей сезонностью: если у категории есть статьи,
   её сумма — сумма статей, чей сезон включает дату выплаты. Сезон — 'ММ-ДД',
   может переходить через Новый год (12-01…03-20). Вне сезона категории — 0.

   Ручная правка (expense_period_overrides) заменяет сумму категории в выплате.
--------------------------------------------------------------------- */

import { daysInclusive, daysInMonth } from './dates.js';
import { expenseAmountOn } from './expense-seasons.js';

export function inSeason(date, from, to) {
  if (!from || !to || !date) return true;
  const md = date.slice(5, 10);
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/* Статья применяется в месяце, если сезон включает хотя бы один его день. */
export function inSeasonMonth(month, from, to) {
  if (!from || !to) return true;
  const [year, m] = month.split('-').map(Number);
  return Array.from({ length: daysInMonth(year, m) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
    .some(date => inSeason(date, from, to));
}

/* Сумма категории на месяц с учётом сезона на дату выплаты */
export function monthlyAmountOn(category, items, date) {
  if (category.mode === 'percent_income') return 0;
  if (!inSeason(date, category.season_from, category.season_to)) return 0;
  const own = items.filter(i => i.category_id === category.id);
  if (own.length) {
    return own.reduce((s, i) => s + expenseAmountOn(i, date), 0);
  }
  return expenseAmountOn(category, date, 'monthly_amount');
}

export function expenseAppliesInMonth(row, month, amountKey = 'amount') {
  if (!inSeasonMonth(month, row.season_from, row.season_to)) return false;
  if (!(row.amount_seasons ?? []).length) return true;
  const [year, m] = month.split('-').map(Number);
  return Array.from({ length: daysInMonth(year, m) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
    .some(date => expenseAmountOn(row, date, amountKey) > 0);
}

const monthOf = p => (p.window_start || p.pay_date).slice(0, 7);

/* Процент подкатегории от полной выплаты, с учётом её периода действия. */
export function itemPercentOn(item, date) {
  if (!inSeason(date, item.season_from, item.season_to)) return 0;
  const percent = Number(item.percent_value);
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

/* При наличии подкатегорий собственный процент категории не прибавляется. */
export function categoryPercentOn(category, date, items = []) {
  if (category.mode !== 'percent_income' || !inSeason(date, category.season_from, category.season_to)) return 0;
  const own = items.filter(i => i.category_id === category.id);
  return own.length ? own.reduce((sum, i) => sum + itemPercentOn(i, date), 0) : itemPercentOn(category, date);
}

/* План подкатегорий в деньгах: ручная сумма выплаты распределяется в их
   пропорциях, а округление сохраняет итог категории. */
export function categoryItemAmounts(category, items, date, total, round = Math.round) {
  if (!inSeason(date, category.season_from, category.season_to)) return new Map();
  const active = items.filter(i => i.category_id === category.id)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.id).localeCompare(String(b.id)))
    .map(i => ({ id: i.id, weight: category.mode === 'percent_income' ? itemPercentOn(i, date) : expenseAmountOn(i, date) }))
    .filter(i => i.weight > 0);
  const weight = active.reduce((sum, i) => sum + i.weight, 0);
  let exact = 0, given = 0;
  return new Map(active.map((i, index) => {
    exact += total * i.weight / weight;
    const amount = round(index === active.length - 1 ? total : exact) - given;
    given += amount;
    return [i.id, amount];
  }));
}

/* Доли выплат в сумме месяца: Map period_id → { share, last, month }.
   Если для года задан график (payout_slots), знаменатель — все выплаты графика
   за месяц, даже если какой-то из них в плане нет (например, аванс за декабрь,
   выплаченный до начала плана): выплата не берёт на себя чужую долю. */
function monthShares(periods, splitMode, slots = []) {
  const byMonth = new Map();
  for (const p of periods.filter(p => !p.sick_leave_id)) {
    const k = monthOf(p);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(p);
  }
  const weight = p => (splitMode === 'by_days'
    ? Math.max(1, daysInclusive(p.window_start || p.pay_date, p.window_end || p.pay_date))
    : 1);
  const shares = new Map();
  for (const [month, list] of byMonth) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const yearSlots = slots.filter(s => Number(s.year) === y);
    const scheduled = list.filter(p => p.slot_order !== null && p.slot_order !== undefined);
    let payers;
    let total;
    let complete;
    if (yearSlots.length && scheduled.length) {
      payers = scheduled;
      const dim = daysInMonth(y, m);
      total = splitMode === 'by_days'
        ? yearSlots.reduce((s, x) => s + Math.max(1, Math.min(x.window_to_day ?? 31, dim) - (x.window_from_day ?? 1) + 1), 0)
        : yearSlots.length;
      complete = scheduled.length >= yearSlots.length;
    } else {
      payers = scheduled.length ? scheduled : list;
      total = payers.reduce((s, p) => s + weight(p), 0);
      complete = true;
    }
    payers.forEach((p, i) => shares.set(p.id, {
      share: weight(p) / total,
      last: complete && i === payers.length - 1,
      month,
    }));
  }
  return shares;
}

/* Расходы по выплатам.
   periods — строки выплат, incomeById — доход на руки выплаты (для процентных категорий).
   Возвращает { byPeriod: Map period_id → { total, categories: [...] }, monthChecks: [...] } */
export function planExpenses({ categories = [], items = [], overrides = [], periods, slots = [], incomeById, round = Math.round, percentBase }) {
  const sorted = [...periods].sort((a, b) => (a.pay_date < b.pay_date ? -1 : a.pay_date > b.pay_date ? 1 : 0));
  const ov = new Map(overrides.map(o => [`${o.period_id}|${o.category_id}`, Number(o.amount) || 0]));
  const cats = [...categories].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const byPeriod = new Map(sorted.map(p => [p.id, { total: 0, categories: [] }]));
  const monthChecks = [];

  const sharesBySplit = {
    even: monthShares(sorted, 'even', slots),
    by_days: monthShares(sorted, 'by_days', slots),
  };

  for (const c of cats) {
    if (c.mode === 'percent_income') {
      const months = new Map();
      for (const p of sorted) {
        const base = Math.max(0, Number(percentBase ? percentBase(p) : (incomeById.get(p.id) ?? 0)) || 0);
        const share = categoryPercentOn(c, p.pay_date, items);
        const planned = round(base * share / 100);
        const key = `${p.id}|${c.id}`;
        const amount = ov.has(key) ? ov.get(key) : planned;
        byPeriod.get(p.id).categories.push({ category_id: c.id, mode: c.mode, planned, amount, share, overridden: ov.has(key) });
        const m = monthOf(p);
        const month = months.get(m) ?? { plan: 0, collected: 0, base: 0 };
        month.plan += planned;
        month.collected += amount;
        if (share > 0) month.base += base;
        months.set(m, month);
      }
      for (const [month, { plan, collected, base }] of months) {
        if (plan > 0) {
          const shortfall = Math.max(0, plan - collected);
          monthChecks.push({
            category_id: c.id, month, plan, collected, share: base > 0 ? plan / base * 100 : 0,
            shortfall, missingPercent: base > 0 ? shortfall / base * 100 : 0,
          });
        }
      }
      continue;
    }

    // fixed_month
    const shares = sharesBySplit[c.split_mode === 'by_days' ? 'by_days' : 'even'];
    const given = new Map();                             // месяц → { exact, rounded }
    for (const p of sorted) {
      const info = shares.get(p.id);
      const monthly = monthlyAmountOn(c, items, p.pay_date);
      let planned = 0;
      if (info && monthly) {
        const g = given.get(info.month) ?? { exact: 0, rounded: 0 };
        const exact = monthly * info.share;
        // последняя выплата месяца забирает только погрешность округления
        planned = info.last ? round(g.exact + exact) - g.rounded : round(exact);
        given.set(info.month, { exact: g.exact + exact, rounded: g.rounded + planned });
      }
      const key = `${p.id}|${c.id}`;
      const amount = ov.has(key) ? ov.get(key) : planned;
      byPeriod.get(p.id).categories.push({ category_id: c.id, mode: c.mode, planned, amount, overridden: ov.has(key) });
    }
  }

  for (const row of byPeriod.values()) row.total = row.categories.reduce((s, x) => s + x.amount, 0);
  return { byPeriod, monthChecks };
}
