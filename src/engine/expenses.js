/* ---------------------------------------------------------------------
   expenses.js — план расходов каждой выплаты.

   Категория (expense_categories) задаёт сумму НА МЕСЯЦ и режим:
   * fixed_month — сумма месяца делится между выплатами этого месяца:
       even    — поровну;
       by_days — пропорционально длине расчётного периода выплаты.
     Остаток от округления уходит в последнюю выплату месяца, чтобы за месяц
     выходила ровно сумма категории.
   * percent_income — доля категории в общих расходах. Процент не задаётся руками:
     сумма всех категорий на месяц — это 100 %, и категория получает свою часть.
     Категория на 10 000 при общих расходах 100 000 — это 10 %, и с каждой выплаты
     в неё уходит 10 % её дохода на руки: с выплаты 1 000 — 100. Сезон меняет
     знаменатель: категория вне сезона в долях не участвует. monthly_amount
     остаётся планом месяца — удержанное за месяц сверяется с ним (monthChecks).

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

export function inSeason(date, from, to) {
  if (!from || !to || !date) return true;
  const md = date.slice(5, 10);
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/* Сумма категории на месяц с учётом сезона на дату выплаты */
export function monthlyAmountOn(category, items, date) {
  if (!inSeason(date, category.season_from, category.season_to)) return 0;
  const own = items.filter(i => i.category_id === category.id);
  if (own.length) {
    return own.reduce((s, i) => s + (inSeason(date, i.season_from, i.season_to) ? Number(i.amount) || 0 : 0), 0);
  }
  return Number(category.monthly_amount) || 0;
}

const monthOf = p => (p.window_start || p.pay_date).slice(0, 7);

/* Доля категории в общих расходах на дату, в процентах.
   Знаменатель — сумма всех категорий на месяц (с учётом сезона), поэтому
   проценты не задаются руками и всегда складываются в 100 %. */
export function categoryShare(category, categories, items, date) {
  const own = monthlyAmountOn(category, items, date);
  if (!(own > 0)) return 0;
  const total = categories.reduce((s, c) => s + monthlyAmountOn(c, items, date), 0);
  return total > 0 ? own / total * 100 : 0;
}

/* Доли выплат в сумме месяца: Map period_id → { share, last, month }.
   Если для года задан график (payout_slots), знаменатель — все выплаты графика
   за месяц, даже если какой-то из них в плане нет (например, аванс за декабрь,
   выплаченный до начала плана): выплата не берёт на себя чужую долю. */
function monthShares(periods, splitMode, slots = []) {
  const byMonth = new Map();
  for (const p of periods) {
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
      const collected = new Map();                       // месяц → удержано
      const shares = new Map();                          // выплата → доля категории, %
      for (const p of sorted) {
        const base = percentBase ? percentBase(p) : (incomeById.get(p.id) ?? 0);
        const share = categoryShare(c, cats, items, p.pay_date);
        shares.set(p.id, share);
        const planned = round(Math.max(0, base) * share / 100);
        const key = `${p.id}|${c.id}`;
        const amount = ov.has(key) ? ov.get(key) : planned;
        byPeriod.get(p.id).categories.push({ category_id: c.id, mode: c.mode, planned, amount, share, overridden: ov.has(key) });
        const m = monthOf(p);
        collected.set(m, (collected.get(m) ?? 0) + amount);
      }
      for (const [month, got] of collected) {
        const plan = monthlyAmountOn(c, items, `${month}-15`);
        if (plan > 0) {
          const share = categoryShare(c, cats, items, `${month}-15`);
          monthChecks.push({
            category_id: c.id, month, plan, collected: got, share,
            shortfall: Math.max(0, plan - got),
            // сколько процентов не хватило, чтобы покрыть план месяца
            missingPercent: got > 0 && plan > got ? share * (plan / got - 1) : 0,
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
