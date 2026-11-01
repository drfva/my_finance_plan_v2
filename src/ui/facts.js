/* Расходы: факт по месяцам против плана */

import { esc, card, table, input, pill } from './dom.js';
import { inSeasonMonth, expenseAppliesInMonth, monthlyAmountOn } from '../engine/expenses.js';
import { expenseAmountOn } from '../engine/expense-seasons.js';

export const code = 'facts';
export const title = () => 'Расходы';
export const hasYears = true;

/* План категории на месяц: сумма того, что заложено в выплаты этого месяца */
function planByMonth(ctx, month) {
  const map = new Map();
  for (const r of ctx.sim.rows) {
    if ((r.period.window_start || r.period.pay_date).slice(0, 7) !== month) continue;
    for (const c of r.expenses.categories) map.set(c.category_id, (map.get(c.category_id) ?? 0) + c.amount);
  }
  return map;
}

export function render(ctx) {
  const { state, fmt, canEdit, ui, year } = ctx;
  const month = ui.draft.facts?.month && ui.draft.facts.month.startsWith(String(year))
    ? ui.draft.facts.month
    : `${year}-${ctx.today.slice(5, 7)}`;
  const cats = (state.expenses?.expense_categories ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const items = state.expenses?.expense_items ?? [];
  const facts = state.facts?.expense_facts ?? [];
  const plan = planByMonth(ctx, month);
  const tolerance = Number(ctx.cfg.get('fact_tolerance_pct')) || 0;

  /* Кружок у месяца: есть факт — цвет по отклонению от плана */
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const tabs = `<div class="month-tabs">${months.map(m => {
    const monthFacts = facts.filter(f => f.ym === m);
    const factSum = monthFacts.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const planSum = [...planByMonth(ctx, m).values()].reduce((s, x) => s + x, 0);
    let dot = '';
    if (monthFacts.length) {
      const diff = factSum - planSum;
      const limit = planSum * tolerance / 100;
      const color = diff > limit ? 'var(--danger)' : diff < -limit ? 'var(--good)' : 'rgba(255,255,255,.55)';
      const title = diff > limit ? 'перерасход' : diff < -limit ? 'уложились' : 'в рамках допуска';
      dot = `<span title="${title}" style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;
        background:${color};border:1px solid var(--line);vertical-align:middle;"></span>`;
    }
    return `<button class="${m === month ? 'active' : ''}" data-fact-month="${m}">${dot}${esc(fmt.month(m, { withYear: false }))}</button>`;
  }).join('')}</div>`;

  const factOf = (categoryId, itemKey = '') => facts.find(f => f.ym === month && f.category_id === categoryId && (f.item_key ?? '') === itemKey);

  const rows = [];
  const planTotal = [...plan.values()].reduce((s, n) => s + n, 0);
  const factTotal = facts.filter(f => f.ym === month).reduce((s, f) => s + (Number(f.amount) || 0), 0);
  for (const c of cats) {
    if (!inSeasonMonth(month, c.season_from, c.season_to)) continue;
    const percent = c.mode === 'percent_income';
    const allItems = percent ? [] : items.filter(i => i.category_id === c.id);
    if (!percent && !allItems.length && !expenseAppliesInMonth(c, month, 'monthly_amount')) continue;
    const own = allItems.filter(i => expenseAppliesInMonth(i, month));
    if (allItems.length && !own.length) continue;
    const catPlan = plan.get(c.id) ?? 0;
    const catFact = facts.filter(f => f.ym === month && f.category_id === c.id).reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const diff = catFact - catPlan;
    const cls = catPlan > 0 && Math.abs(diff) > catPlan * tolerance / 100 ? (diff > 0 ? 'fact-over' : 'fact-under') : 'fact-even';
    rows.push(`<tr class="${cls}">
      <td><b>${esc(c.title)}</b></td>
      <td class="num muted">${esc(fmt.money(catPlan))}</td>
      <td class="num">${own.length ? esc(fmt.money(catFact)) : input({
        edit: 'facts|expense_facts|amount', key: { ym: month, category_id: c.id, item_key: '' },
        defaults: { category_title: c.title, item_title: '' },
        value: factOf(c.id)?.amount ?? '', type: 'money', removeWhen: '0', disabled: !canEdit, style: 'max-width:130px;text-align:right;' })}</td>
      <td class="num diff">${catPlan || catFact ? esc(fmt.money(diff, undefined, { sign: true })) : ''}</td>
    </tr>`);
    for (const i of own) {
      const itemPlan = ctx.sim.rows.filter(r => (r.period.window_start || r.period.pay_date).slice(0,7) === month).reduce((sum, r) => {
        const monthly = monthlyAmountOn(c, allItems, r.period.pay_date);
        const amount = r.expenses.categories.find(x => x.category_id === c.id)?.amount ?? 0;
        return sum + (monthly > 0 ? amount * expenseAmountOn(i, r.period.pay_date) / monthly : 0);
      }, 0);
      rows.push(`<tr class="fact-item">
        <td>${esc(i.title)}</td>
        <td class="num muted">${esc(fmt.money(itemPlan))}</td>
        <td class="num">${input({
          edit: 'facts|expense_facts|amount', key: { ym: month, category_id: c.id, item_key: i.id },
          defaults: { category_title: c.title, item_title: i.title },
          value: factOf(c.id, i.id)?.amount ?? '', type: 'money', removeWhen: '0', disabled: !canEdit, style: 'max-width:130px;text-align:right;' })}</td>
        <td></td>
      </tr>`);
    }
    // Старые факты по статьям сохраняются при переходе на процент категории.
    if (percent) for (const f of facts.filter(f => f.ym === month && f.category_id === c.id && f.item_key)) {
      rows.push(`<tr class="fact-item">
        <td>${esc(f.item_title || f.item_key)} <span class="small-note">ранее внесено по статье</span></td>
        <td class="num muted">—</td><td class="num">${input({
          edit: 'facts|expense_facts|amount', key: { ym: month, category_id: c.id, item_key: f.item_key },
          value: f.amount, type: 'money', removeWhen: '0', disabled: !canEdit, style: 'max-width:130px;text-align:right;',
        })}</td><td></td></tr>`);
    }
  }

  // факт по категориям, которых в плане уже нет — историю не теряем
  const extra = facts.filter(f => f.ym === month && !cats.some(c => c.id === f.category_id));
  for (const f of extra) {
    rows.push(`<tr><td>${esc(f.category_title || f.category_id)} <span class="small-note">нет в плане</span></td>
      <td class="num muted"></td><td class="num">${esc(fmt.money(f.amount))}</td><td></td></tr>`);
  }

  const diff = factTotal - planTotal;
  const withinTolerance = planTotal > 0 && Math.abs(diff) <= planTotal * tolerance / 100;
  const diffColor = withinTolerance ? '' : diff > 0 ? 'color:var(--danger);' : 'color:var(--good);';
  const stats = `<div class="grid cols-3">
    <div class="card stat"><div class="v">${esc(fmt.money(planTotal))}</div><div class="l">план на месяц</div></div>
    <div class="card stat"><div class="v">${esc(fmt.money(factTotal))}</div><div class="l">факт за месяц</div></div>
    <div class="card stat"><div class="v" style="${diffColor}">${esc(fmt.money(diff, undefined, { sign: true }))}</div>
      <div class="l">${diff > 0 ? 'потрачено больше' : diff < 0 ? 'потрачено меньше' : 'ровно по плану'}</div></div>
  </div>`;

  return `${tabs}
    ${stats}
    ${card({
      title: `Факт за ${fmt.month(month)}`,
      body: table({
        head: ['Категория', { title: 'План', cls: 'num' }, { title: 'Факт', cls: 'num' }, { title: 'Отклонение', cls: 'num' }],
        rows: rows.length ? rows : ['<tr><td colspan="4" class="muted">Категорий нет</td></tr>'],
        foot: `<tr><td><b>Итого</b></td><td class="num">${esc(fmt.money(planTotal))}</td><td class="num"><b>${esc(fmt.money(factTotal))}</b></td>
          <td class="num">${esc(fmt.money(diff, undefined, { sign: true }))}</td></tr>`,
      }),
    })}
    <div class="row wrap" style="gap:8px;">${pill(`за год факт ${fmt.money(facts.filter(f => f.ym.startsWith(String(year))).reduce((s, f) => s + (Number(f.amount) || 0), 0))}`)}</div>`;
}

export function handle(ev, ctx) {
  const btn = ev.target.closest('[data-fact-month]');
  if (!btn) return false;
  (ctx.ui.draft.facts ?? (ctx.ui.draft.facts = {})).month = btn.dataset.factMonth;
  return true;
}
