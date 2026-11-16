/* Расходы: факт по месяцам против плана */

import { esc, card, table, input, pill } from './dom.js';
import { inSeasonMonth, expenseAppliesInMonth, categoryItemAmounts } from '../engine/expenses.js';
import { categoryFactCell, expenseFactActions, expenseFactRows, expenseTrackingPanel, manualCategoryFact } from './expense-tracking.js';

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
  const journalEnabled = Boolean(ctx.tracking?.enabled);
  const editFact = canEdit && !journalEnabled;
  const month = ui.draft.facts?.month && ui.draft.facts.month.startsWith(String(year))
    ? ui.draft.facts.month
    : `${year}-${ctx.today.slice(5, 7)}`;
  const cats = (state.expenses?.expense_categories ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const items = state.expenses?.expense_items ?? [];
  const {totals:facts,details:detailFacts} = expenseFactRows(ctx,state.facts?.expense_facts);
  const canOverride = Array.isArray(ctx.tracking?.fact_overrides);
  const canOverrideItems = ctx.tracking?.fact_items_supported;
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

  const factOf = (categoryId, itemKey = '') => detailFacts.find(f => f.ym === month && f.category_id === categoryId && (f.item_key ?? '') === itemKey);

  const rows = [];
  const planTotal = [...plan.values()].reduce((s, n) => s + n, 0);
  const factTotal = facts.filter(f => f.ym === month).reduce((s, f) => s + (Number(f.amount) || 0), 0);
  for (const c of cats) {
    const hasFact = manualCategoryFact(ctx,month,c.id) || (journalEnabled || canOverrideItems) && facts.some(f => f.ym === month && f.category_id === c.id);
    if (!inSeasonMonth(month, c.season_from, c.season_to) && !hasFact) continue;
    const percent = c.mode === 'percent_income';
    const allItems = items.filter(i => i.category_id === c.id);
    if (!percent && !allItems.length && !expenseAppliesInMonth(c, month, 'monthly_amount') && !hasFact) continue;
    const own = allItems.filter(i => (journalEnabled || canOverrideItems) && factOf(c.id,i.id)
      || (percent ? inSeasonMonth(month, i.season_from, i.season_to) : expenseAppliesInMonth(i, month)));
    if (allItems.length && !own.length && !hasFact) continue;
    const catPlan = plan.get(c.id) ?? 0;
    const catFact = facts.filter(f => f.ym === month && f.category_id === c.id).reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const diff = catFact - catPlan;
    const cls = catPlan > 0 && Math.abs(diff) > catPlan * tolerance / 100 ? (diff > 0 ? 'fact-over' : 'fact-under') : 'fact-even';
    rows.push(`<tr class="${cls}">
      <td><b>${esc(c.title)}</b></td>
      <td class="num muted">${esc(fmt.money(catPlan))}</td>
      <td class="num">${canOverride ? categoryFactCell(ctx,month,c,catFact) : own.length || journalEnabled ? esc(fmt.money(catFact)) : input({
        edit: 'facts|expense_facts|amount', key: { ym: month, category_id: c.id, item_key: '' },
        defaults: { category_title: c.title, item_title: '' },
        value: factOf(c.id)?.amount ?? '', type: 'money', removeWhen: '0', disabled: !editFact, cls: factOf(c.id) ? 'own' : '', style: 'max-width:130px;text-align:right;' })}</td>
      <td class="num diff">${catPlan || catFact ? esc(fmt.money(diff, undefined, { sign: true })) : ''}</td>
    </tr>`);
    const itemPlans = new Map();
    for (const r of ctx.sim.rows.filter(r => (r.period.window_start || r.period.pay_date).slice(0, 7) === month)) {
      const amount = r.expenses.categories.find(x => x.category_id === c.id)?.amount ?? 0;
      for (const [id, value] of categoryItemAmounts(c, allItems, r.period.pay_date, amount, fmt.round)) {
        itemPlans.set(id, (itemPlans.get(id) ?? 0) + value);
      }
    }
    for (const i of own) {
      const itemPlan = itemPlans.get(i.id) ?? 0;
      rows.push(`<tr class="fact-item">
        <td>${esc(i.title)}</td>
        <td class="num muted">${esc(fmt.money(itemPlan))}</td>
        <td class="num">${canOverrideItems ? categoryFactCell(ctx,month,c,factOf(c.id,i.id)?.amount ?? 0,i)
          : journalEnabled ? esc(fmt.money(factOf(c.id,i.id)?.amount ?? 0)) : input({
          edit: 'facts|expense_facts|amount', key: { ym: month, category_id: c.id, item_key: i.id },
          defaults: { category_title: c.title, item_title: i.title },
          value: factOf(c.id, i.id)?.amount ?? '', type: 'money', removeWhen: '0', disabled: !editFact, cls: factOf(c.id,i.id) ? 'own' : '', style: 'max-width:130px;text-align:right;' })}</td>
        <td></td>
      </tr>`);
    }
    // Старый факт категории и факты отсутствующих подкатегорий остаются доступны.
    if (percent || canOverrideItems) for (const f of detailFacts.filter(f => f.ym === month && f.category_id === c.id
      && (f.item_key ? !allItems.some(i => i.id === f.item_key) : own.length > 0))) {
      rows.push(`<tr class="fact-item">
        <td>${esc(f.item_key ? f.item_title || f.item_key : 'Без подкатегории')}${f.item_key || !canOverrideItems ? ` <span class="small-note">${f.item_key ? 'ранее внесено по статье' : 'ранее внесено по категории'}</span>` : ''}</td>
        <td class="num muted">—</td><td class="num">${journalEnabled ? esc(fmt.money(f.amount)) : input({
          edit: 'facts|expense_facts|amount', key: { ym: month, category_id: c.id, item_key: f.item_key ?? '' },
          value: f.amount, type: 'money', removeWhen: '0', disabled: !editFact, cls: 'own', style: 'max-width:130px;text-align:right;',
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
    ${expenseTrackingPanel(ctx, month)}
    ${card({
      title: `Факт за ${fmt.month(month)}`,
      actions: expenseFactActions(ctx),
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
