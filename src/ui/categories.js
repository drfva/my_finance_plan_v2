/* Категории расходов: сумма на месяц, режим, сезон и статьи */

import { esc, card, table, input, select, addButton, delButton, button, pill, field } from './dom.js';
import { uid } from './edit.js';
import { monthlyAmountOn, categoryShare, inSeason } from '../engine/expenses.js';
import { amountSeasons, amountSeasonHandle, amountSeasonChange } from './expense-seasons.js';

export const handleChange = amountSeasonChange;

export const code = 'categories';
export const title = () => 'Категории';

const SEASON_HINT = 'Формат ММ-ДД, например 12-01. Можно через Новый год: с 12-01 по 03-20.';

/* Сезон категории или статьи: пока не задан — только кнопка */
function seasonBlock(ctx, { domain, table: tbl, id, from, to }) {
  const { canEdit } = ctx;
  const key = { id };
  if (!from && !to) {
    return canEdit ? button({ action: 'add-season', value: `${domain}|${tbl}|${id}`, label: '+ период действия', cls: 'ghost small',
      title: 'Ограничить период, когда учитывается строка' }) : '';
  }
  return `<div class="category-season-fields">
    ${field('Период действия с', input({ edit: `${domain}|${tbl}|season_from`, key, value: from, placeholder: 'ММ-ДД', disabled: !canEdit }))}
    ${field('по', input({ edit: `${domain}|${tbl}|season_to`, key, value: to, placeholder: 'ММ-ДД', disabled: !canEdit }))}
    ${canEdit ? button({ action: 'drop-season', value: `${domain}|${tbl}|${id}`, label: 'убрать период', cls: 'ghost small' }) : ''}
    <div class="small-note season-format-note">${SEASON_HINT} Вне периода строка не учитывается. Ограничение применяется ко всем её сезонным суммам.</div>
  </div>`;
}

function itemsBlock(ctx, cat) {
  const { state, canEdit } = ctx;
  const items = (state.expenses?.expense_items ?? []).filter(i => i.category_id === cat.id)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const rows = items.map(i => `<div class="category-item" data-scroll-row="${esc(i.id)}">
    <div class="category-item-main">
      ${field('Статья', input({ edit: 'expenses|expense_items|title', key: { id: i.id }, value: i.title, disabled: !canEdit }))}
      ${field('Основная сумма в месяц', input({ edit: 'expenses|expense_items|amount', key: { id: i.id }, value: i.amount, type: 'money', disabled: !canEdit }))}
      <div class="category-item-actions">
        ${!i.season_from && !i.season_to ? seasonBlock(ctx, { domain: 'expenses', table: 'expense_items', id: i.id }) : ''}
        ${canEdit ? delButton({ domain: 'expenses', table: 'expense_items', key: { id: i.id } }) : ''}
      </div>
    </div>
    ${i.season_from || i.season_to ? seasonBlock(ctx, { domain: 'expenses', table: 'expense_items', id: i.id, from: i.season_from, to: i.season_to }) : ''}
    ${amountSeasons(ctx, 'expense_items', i)}
  </div>`).join('');
  return `<div class="category-items">
    <div class="category-items-title"><h3>Статьи${items.length ? ` · ${items.length}` : ''}</h3>
      ${canEdit ? addButton({ domain: 'expenses', table: 'expense_items', label: '+ статья',
        row: { id: uid('item'), category_id: cat.id, title: 'Новая статья', amount: 0, sort_order: Math.max(0, ...items.map(i => i.sort_order ?? 0)) + 1 } }) : ''}
    </div>
    ${rows || '<div class="small-note">Можно разбить сумму категории на отдельные статьи.</div>'}
  </div>`;
}

export function render(ctx) {
  const { state, fmt, canEdit, sim, cfg, ui } = ctx;
  const cats = (state.expenses?.expense_categories ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const items = state.expenses?.expense_items ?? [];
  const modes = cfg.list('expense_modes').map(m => ({ value: m.code, label: m.title }));
  const splits = cfg.list('split_modes').map(m => ({ value: m.code, label: m.title }));

  const monthTotal = cats.reduce((s, c) => s + (c.mode === 'percent_income' ? 0 : monthlyAmountOn(c, items, ctx.today)), 0);
  const percentTotal = cats.filter(c => c.mode === 'percent_income')
    .reduce((s, c) => s + categoryShare(c, cats, items, ctx.today), 0);

  const cards = cats.map(c => {
    const open = ui.open.has(`cat:${c.id}`);
    const monthly = monthlyAmountOn(c, items, ctx.today);
    const ownItems = items.filter(i => i.category_id === c.id);
    const hasItems = ownItems.length > 0;
    const percent = c.mode === 'percent_income';
    const share = categoryShare(c, cats, items, ctx.today);
    const splitTitle = c.split_mode === 'by_days' ? 'по дням периода' : 'поровну между выплатами';
    const metadata = [
      hasItems ? `${ownItems.length} ${fmt.plural(ownItems.length, { one: 'статья', few: 'статьи', many: 'статей' })}` : (percent ? '' : 'фиксированная сумма'),
      percent ? `план ${fmt.money(monthly)} в месяц` : splitTitle,
      c.season_from && c.season_to ? `сезон ${c.season_from}–${c.season_to}` : '',
      !inSeason(ctx.today, c.season_from, c.season_to) ? 'сейчас вне сезона' : '',
    ].filter(Boolean).join(' · ');
    return `<section class="card category-card" data-section="cat:${esc(c.id)}">
      <h2 class="category-heading"><button class="category-head" data-toggle="cat:${esc(c.id)}" aria-expanded="${open}"
        aria-controls="category-body-${esc(c.id)}">
        <span class="chev${open ? ' open' : ''}" aria-hidden="true">▸</span>
        <span class="category-caption"><span class="category-name">${esc(c.title || 'Без названия')}</span>
          <span class="category-meta">${esc(metadata)}</span></span>
        <span class="category-amount num">${esc(percent ? fmt.percent(share, 1) : fmt.money(monthly))}
          <span class="category-meta">${percent ? 'от выплаты' : 'в месяц'}</span></span>
      </button></h2>
      <div id="category-body-${esc(c.id)}"${open ? '' : ' hidden'}>${open ? `
        <div class="category-editor">
          <div class="grid cols-2">
            ${field('Название', input({ edit: 'expenses|expense_categories|title', key: { id: c.id }, value: c.title, disabled: !canEdit }))}
            ${field('Как считать', select({ edit: 'expenses|expense_categories|mode', key: { id: c.id }, value: c.mode, options: modes, disabled: !canEdit }))}
            ${field('Сумма на месяц', input({ edit: 'expenses|expense_categories|monthly_amount', key: { id: c.id }, value: hasItems ? monthly : c.monthly_amount, type: 'money', disabled: !canEdit || hasItems }),
              hasItems ? 'Складывается из статей с учётом сезона' : (c.amount_seasons?.length ? 'Основная сумма действует вне сезонов с отдельной суммой' : ''))}
            ${percent
              ? field('Доля от выплаты', `<div class="category-share num">${esc(fmt.percent(share, 1))}</div>`, 'Сумма категории ÷ общий план расходов. Доля пересчитывается автоматически.')
              : field('Делить между выплатами', select({ edit: 'expenses|expense_categories|split_mode', key: { id: c.id }, value: c.split_mode, options: splits, disabled: !canEdit }))}
          </div>
          <div class="category-season">${seasonBlock(ctx, { domain: 'expenses', table: 'expense_categories', id: c.id, from: c.season_from, to: c.season_to })}</div>
          ${!hasItems ? amountSeasons(ctx, 'expense_categories', c) : ''}
          ${itemsBlock(ctx, c)}
          ${canEdit ? `<div class="category-delete">${delButton({ domain: 'expenses', table: 'expense_categories', key: { id: c.id },
            label: 'Удалить категорию', confirm: `Удалить категорию «${c.title}» вместе со статьями, правками в выплатах и фактом?` })}</div>` : ''}
        </div>` : ''}</div>
    </section>`;
  }).join('');

  const perPeriod = sim.rows.filter(r => Number(r.period.year) === ctx.year);
  const preview = perPeriod.slice(0, 4).map(r => `<tr><td>${esc(fmt.date(r.period.pay_date))}</td><td class="num">${esc(fmt.money(r.categoriesTotal))}</td></tr>`);

  return `
    <div class="category-toolbar">
      <div><h2>Категории</h2><div class="small-note">На ${esc(fmt.date(ctx.today))} · ${cats.length} ${fmt.plural(cats.length, { one: 'категория', few: 'категории', many: 'категорий' })}</div>
        <div class="row wrap" style="gap:8px;margin-top:10px;">
          ${pill(`${fmt.money(monthTotal)} в месяц фиксированными`)}
          ${percentTotal ? pill(`${fmt.percent(percentTotal, 1)} от выплаты процентными`) : ''}
        </div>
      </div>
      ${canEdit ? addButton({ domain: 'expenses', table: 'expense_categories', cls: 'primary small', label: '+ категория',
        row: { id: uid('cat'), title: 'Новая категория', mode: 'fixed_month', monthly_amount: 0, percent_value: 0, split_mode: 'even', sort_order: Math.max(0, ...cats.map(c => c.sort_order ?? 0)) + 1 } }) : ''}
    </div>
    <div class="category-list">${cards || '<div class="card muted">Категорий пока нет.</div>'}</div>
    ${perPeriod.length ? card({ title: 'Сколько выйдет по выплатам', note: 'Первые выплаты выбранного года', body: table({ head: ['Выплата', { title: 'Расходы', cls: 'num' }], rows: preview }) }) : ''}`;
}

export function handle(ev, ctx) {
  if (amountSeasonHandle(ev, ctx)) return true;
  if (!ctx.canEdit) return false;
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
