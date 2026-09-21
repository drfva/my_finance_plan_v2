/* Категории расходов: сумма на месяц, режим, сезон и статьи */

import { esc, card, table, input, select, addButton, delButton, button, pill, field } from './dom.js';
import { uid } from './edit.js';
import { monthlyAmountOn } from '../engine/expenses.js';

export const code = 'categories';
export const title = () => 'Категории';

const SEASON_HINT = 'Формат ММ-ДД, например 12-01. Можно через Новый год: с 12-01 по 03-20.';

/* Сезон категории или статьи: пока не задан — только кнопка */
function seasonBlock(ctx, { domain, table: tbl, id, from, to }) {
  const { canEdit } = ctx;
  const key = { id };
  if (!from && !to) {
    return canEdit ? button({ action: 'add-season', value: `${domain}|${tbl}|${id}`, label: '+ сезон', cls: 'ghost small',
      title: 'Категория считается только в свой сезон' }) : '';
  }
  return `<div class="row wrap" style="gap:10px;align-items:end;">
    ${field('Сезон с', input({ edit: `${domain}|${tbl}|season_from`, key, value: from, placeholder: 'ММ-ДД', disabled: !canEdit, style: 'max-width:120px;' }), SEASON_HINT)}
    ${field('по', input({ edit: `${domain}|${tbl}|season_to`, key, value: to, placeholder: 'ММ-ДД', disabled: !canEdit, style: 'max-width:120px;' }))}
    ${canEdit ? button({ action: 'drop-season', value: `${domain}|${tbl}|${id}`, label: 'убрать сезон', cls: 'ghost small' }) : ''}
  </div>`;
}

function itemsBlock(ctx, cat) {
  const { state, canEdit } = ctx;
  const items = (state.expenses?.expense_items ?? []).filter(i => i.category_id === cat.id)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const rows = items.map(i => `<div class="item-row" style="grid-template-columns:1.6fr 1fr auto auto;align-items:start;margin-bottom:6px;">
    ${field('Статья', input({ edit: 'expenses|expense_items|title', key: { id: i.id }, value: i.title, disabled: !canEdit }), '')}
    ${field('Сумма в месяц', input({ edit: 'expenses|expense_items|amount', key: { id: i.id }, value: i.amount, type: 'money', disabled: !canEdit }))}
    <div>${seasonBlock(ctx, { domain: 'expenses', table: 'expense_items', id: i.id, from: i.season_from, to: i.season_to })}</div>
    ${canEdit ? delButton({ domain: 'expenses', table: 'expense_items', key: { id: i.id } }) : ''}
  </div>`).join('');
  return `<div style="margin-top:14px;">
    <div class="small-note">Статьи разбивают категорию на части. Если они есть, сумма категории — сумма статей, попавших в сезон.</div>
    ${rows}
    ${canEdit ? addButton({ domain: 'expenses', table: 'expense_items', label: '+ статья',
      row: { id: uid('item'), category_id: cat.id, title: 'Новая статья', amount: 0, sort_order: items.length + 1 } }) : ''}
  </div>`;
}

export function render(ctx) {
  const { state, fmt, canEdit, sim, cfg, ui } = ctx;
  const cats = (state.expenses?.expense_categories ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const items = state.expenses?.expense_items ?? [];
  const modes = cfg.list('expense_modes').map(m => ({ value: m.code, label: m.title }));
  const splits = cfg.list('split_modes').map(m => ({ value: m.code, label: m.title }));

  const monthTotal = cats.reduce((s, c) => s + (c.mode === 'percent_income' ? 0 : monthlyAmountOn(c, items, ctx.today)), 0);
  const percentTotal = cats.filter(c => c.mode === 'percent_income').reduce((s, c) => s + (Number(c.percent_value) || 0), 0);

  const cards = cats.map(c => {
    const open = ui.open.has(`cat:${c.id}`);
    const monthly = monthlyAmountOn(c, items, ctx.today);
    const hasItems = items.some(i => i.category_id === c.id);
    const percent = c.mode === 'percent_income';
    return card({
      body: `
        <div class="row wrap" style="gap:12px;align-items:start;">
          <div style="flex:2;min-width:200px;">${field('Название', input({ edit: 'expenses|expense_categories|title', key: { id: c.id }, value: c.title, disabled: !canEdit }))}</div>
          <div style="flex:1;min-width:190px;">${field('Как считать', select({ edit: 'expenses|expense_categories|mode', key: { id: c.id }, value: c.mode, options: modes, disabled: !canEdit }),
            percent ? '% с каждой выплаты' : 'Сумма месяца делится между выплатами')}</div>
          ${percent
            ? `<div style="flex:1;min-width:140px;">${field('Процент с выплаты', input({ edit: 'expenses|expense_categories|percent_value', key: { id: c.id }, value: c.percent_value, type: 'number', disabled: !canEdit }), 'От суммы на руки')}</div>
               <div style="flex:1;min-width:150px;">${field('План на месяц', input({ edit: 'expenses|expense_categories|monthly_amount', key: { id: c.id }, value: c.monthly_amount, type: 'money', disabled: !canEdit }), 'Для сверки за месяц')}</div>`
            : `<div style="flex:1;min-width:150px;">${field('Сумма на месяц', input({ edit: 'expenses|expense_categories|monthly_amount', key: { id: c.id }, value: hasItems ? monthly : c.monthly_amount, type: 'money', disabled: !canEdit || hasItems }),
                 hasItems ? 'Сумма статей' : 'Уходит за месяц целиком')}</div>
               <div style="flex:1;min-width:200px;">${field('Деление между выплатами', select({ edit: 'expenses|expense_categories|split_mode', key: { id: c.id }, value: c.split_mode, options: splits, disabled: !canEdit }),
                 'Поровну или по длине периода')}</div>`}
          <div>${field(' ', `<button class="ghost small" data-toggle="cat:${esc(c.id)}">${open ? 'свернуть' : 'сезон и статьи'}</button>`)}</div>
          ${canEdit ? `<div>${field(' ', delButton({ domain: 'expenses', table: 'expense_categories', key: { id: c.id }, confirm: `Удалить категорию «${c.title}» вместе со статьями, правками в выплатах и фактом?` }))}</div>` : ''}
        </div>
        <div class="small-note" style="margin-top:6px;">
          ${percent
            ? `${esc(fmt.percent(Number(c.percent_value) || 0, 1))} с каждой выплаты, план месяца ${esc(fmt.money(c.monthly_amount))}`
            : `${esc(fmt.money(monthly))} в месяц${hasItems ? ' (сумма статей)' : ''}`}
          ${c.season_from && c.season_to ? ` · сезон ${esc(c.season_from)}…${esc(c.season_to)}` : ''}
        </div>
        ${open ? `<div style="margin-top:12px;">
            ${seasonBlock(ctx, { domain: 'expenses', table: 'expense_categories', id: c.id, from: c.season_from, to: c.season_to })}
          </div>${itemsBlock(ctx, c)}` : ''}`,
    });
  }).join('');

  const perPeriod = sim.rows.filter(r => Number(r.period.year) === ctx.year);
  const preview = perPeriod.slice(0, 4).map(r => `<tr><td>${esc(fmt.date(r.period.pay_date))}</td><td class="num">${esc(fmt.money(r.categoriesTotal))}</td></tr>`);

  return `
    <div class="row wrap" style="gap:8px;">
      ${pill(`${esc(fmt.money(monthTotal))} в месяц фиксированными`)}
      ${percentTotal ? pill(`${esc(fmt.percent(percentTotal, 1))} от выплаты процентными`) : ''}
      ${canEdit ? addButton({ domain: 'expenses', table: 'expense_categories', cls: 'primary small', label: '+ категория',
        row: { id: uid('cat'), title: 'Новая категория', mode: 'fixed_month', monthly_amount: 0, percent_value: 0, split_mode: 'even', sort_order: cats.length + 1 } }) : ''}
    </div>
    ${cards || '<div class="card muted">Категорий пока нет.</div>'}
    ${perPeriod.length ? card({ title: 'Сколько выйдет по выплатам', note: 'Первые выплаты выбранного года', body: table({ head: ['Выплата', { title: 'Расходы', cls: 'num' }], rows: preview }) }) : ''}`;
}

export function handle(ev, ctx) {
  const { store } = ctx;
  const add = ev.target.closest('[data-add-season]');
  const drop = ev.target.closest('[data-drop-season]');
  const el = add ?? drop;
  if (!el) return false;
  const [domain, tbl, id] = (add ? el.dataset.addSeason : el.dataset.dropSeason).split('|');
  store.update(domain, d => {
    const row = (d[tbl] ?? []).find(r => r.id === id);
    if (!row) return;
    row.season_from = add ? '01-01' : null;
    row.season_to = add ? '12-31' : null;
  });
  return true;
}
