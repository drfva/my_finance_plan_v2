import { esc, button, field } from './dom.js';
import { validateAmountSeasons } from '../engine/expense-seasons.js';

const value = (table, id, index) => JSON.stringify({ table, id, index });

export function amountSeasons(ctx, table, row) {
  const seasons = row.amount_seasons ?? [];
  const draft = ctx.ui.draft.amountSeason;
  const editing = draft?.table === table && draft.id === row.id;
  const control = (key, label, placeholder) => field(label, `<input data-amount-season-field="${key}" aria-label="${esc(label)}" value="${esc(draft?.[key] ?? '')}"
    ${key === 'amount' ? 'inputmode="decimal"' : 'maxlength="5"'} placeholder="${esc(placeholder)}">`);
  return `<div class="amount-seasons">
    <div class="amount-seasons-head"><b>Суммы по сезонам</b>${ctx.canEdit ? button({ action: 'amount-season-edit', value: value(table, row.id, null), label: '+ сезон с суммой', cls: 'ghost small' }) : ''}</div>
    ${seasons.map((season, index) => `<div class="amount-season-row"><span>${esc(season.from)} — ${esc(season.to)}</span><b class="num">${esc(ctx.fmt.money(season.amount))} / месяц</b>
      ${ctx.canEdit ? `<div class="row">${button({ action: 'amount-season-edit', value: value(table, row.id, index), label: 'Изменить', cls: 'ghost small' })}${button({ action: 'amount-season-delete', value: value(table, row.id, index), label: '✕', cls: 'ghost small', title: 'Удалить сезон суммы' })}</div>` : ''}</div>`).join('')}
    ${editing && ctx.canEdit ? `<div class="amount-season-form">
      <div class="amount-season-fields">${control('from', 'Сезон с', 'ММ-ДД')}${control('to', 'По', 'ММ-ДД')}${control('amount', 'Сумма в месяц', '0')}</div>
      <div class="small-note">Границы включены. Можно через Новый год: 12-01 — 03-20. Вне этих сезонов действует основная сумма.</div>
      <div class="row wrap">${button({ action: 'amount-season-save', label: 'Применить', cls: 'primary small' })}${button({ action: 'amount-season-cancel', label: 'Отмена', cls: 'ghost small' })}</div>
    </div>` : ''}
  </div>`;
}

export function amountSeasonChange(ev, ctx) {
  const field = ev.target.closest('[data-amount-season-field]');
  if (!field || !ctx.canEdit || !ctx.ui.draft.amountSeason) return false;
  ctx.ui.draft.amountSeason[field.dataset.amountSeasonField] = field.value;
  return true;
}

export function amountSeasonHandle(ev, ctx) {
  if (!ctx.canEdit) return false;
  if (ev.target.closest('[data-amount-season-cancel]')) { delete ctx.ui.draft.amountSeason; return true; }
  const edit = ev.target.closest('[data-amount-season-edit]'), del = ev.target.closest('[data-amount-season-delete]');
  if (edit || del) {
    const key = JSON.parse(edit ? edit.dataset.amountSeasonEdit : del.dataset.amountSeasonDelete);
    if (!['expense_categories','expense_items'].includes(key.table)) return false;
    const row = ctx.state.expenses?.[key.table]?.find(r => r.id === key.id);
    if (!row) return false;
    if (edit) {
      const season = key.index === null ? { from: '', to: '', amount: '' } : row.amount_seasons?.[key.index];
      if (!season) return false;
      ctx.ui.draft.amountSeason = { ...key, ...season, original: JSON.stringify(row.amount_seasons ?? []) };
    } else {
      ctx.store.update('expenses', d => { d[key.table].find(r => r.id === key.id).amount_seasons = (row.amount_seasons ?? []).filter((_, i) => i !== key.index); });
      delete ctx.ui.draft.amountSeason;
    }
    return true;
  }
  if (!ev.target.closest('[data-amount-season-save]')) return false;
  const draft = ctx.ui.draft.amountSeason;
  if (!draft) return false;
  const row = ctx.state.expenses?.[draft.table]?.find(r => r.id === draft.id);
  if (!row) return false;
  if (JSON.stringify(row.amount_seasons ?? []) !== draft.original) throw new Error('Сезоны изменились. Откройте редактирование заново');
  const amount = ctx.fmt.parseMoney(draft.amount);
  const season = { from: draft.from.trim(), to: draft.to.trim(), amount: String(draft.amount).trim() ? amount : null };
  const next = [...(row.amount_seasons ?? [])];
  if (draft.index === null) next.push(season); else next[draft.index] = season;
  const error = validateAmountSeasons(next);
  if (error) throw new Error(error);
  delete ctx.ui.draft.amountSeason;
  ctx.store.update('expenses', d => { d[draft.table].find(r => r.id === draft.id).amount_seasons = next; });
  return true;
}
