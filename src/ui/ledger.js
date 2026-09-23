/* ---------------------------------------------------------------------
   ledger.js — отдельная вкладка «История баланса копилки».

   Открывается кнопкой из карточки цели (ui.goal — какая именно), показывает
   все движения по копилке по порядку: начальный остаток, отчисления из выплат
   плана, траты, пополнения и переводы между целями — с остатком после каждого
   движения и тем, что при этом стало с этапами.
--------------------------------------------------------------------- */

import { esc, card, table, num, cell, row, button, pill } from './dom.js';
import { goalBalanceAt, goalProgressAt } from '../engine/allocation.js';
import { goalTotal } from '../engine/savings.js';

export const code = 'ledger';
export const title = () => 'История баланса';

const KIND_TITLES = { bucket: 'копилка', reserve: 'подушка', gifts: 'подарки' };
const TAB_OF = { bucket: 'goals', reserve: 'reserves', gifts: 'gifts' };

const goalsOf = ctx => (ctx.state.savings?.goals ?? [])
  .slice().sort((a, b) => (a.kind_code < b.kind_code ? -1 : a.kind_code > b.kind_code ? 1 : (a.priority ?? 0) - (b.priority ?? 0)));

/* История баланса копилки: отчисления из выплат, траты и переводы по порядку,
   с остатком после каждого движения и тем, что при этом стало с этапами. */
export function ledgerTable(ctx, g) {
  const { fmt, sim, state } = ctx;
  const list = sim.milestonesOf(g);
  const entries = (sim.ledgerOf?.(g.id) ?? []).filter(e => e.note?.source !== 'start' || Math.abs(e.delta) > 0.0001 || e.closed.length);
  if (!entries.length) return '<div class="muted">Движений по копилке нет: ни отчислений из выплат, ни трат.</div>';

  const goalTitle = id => (state.savings?.goals ?? []).find(x => x.id === id)?.title ?? '—';
  const msName = i => `${i + 1}. ${list[i]?.title || 'этап'}`;
  const what = e => {
    const n = e.note ?? {};
    if (n.source === 'start') return ['Начальный остаток', ''];
    if (n.source === 'plan') {
      const r = sim.byId?.get(n.period_id);
      return ['Отчисление из выплаты', r ? `${r.period.title || 'выплата'} ${fmt.date(r.period.pay_date)}` : ''];
    }
    const mi = n.milestone_id ? list.findIndex(m => m.id === n.milestone_id) : -1;
    const forMs = mi >= 0 ? `<span class="small-note" style="margin:0;display:block;">за этап ${esc(msName(mi))}</span>` : '';
    const title = (n.title ? esc(n.title) : '') + forMs;
    if (n.kind === 'transfer_out') return [`Перевод в «${esc(goalTitle(n.counterparty_id))}»`, title];
    if (n.kind === 'transfer_in') return [`Перевод из «${esc(goalTitle(n.counterparty_id))}»`, title];
    return [n.kind === 'spend' ? 'Трата' : 'Пополнение', title];
  };

  const rows = entries.map((e, n) => {
    const [head, note] = what(e);
    const cur = list[e.phase.idx];
    const was = entries[n - 1]?.drained ?? [];
    const marks = [
      ...e.closed.map(i => pill(`закрыт ${msName(i)}`, 'ok')),
      ...e.reopened.map(i => pill(`снова открыт ${msName(i)}`, 'warn')),
      ...e.drained.filter(i => !was.includes(i) && !e.closed.includes(i))
        .map(i => pill(`резерв «${msName(i)}» потрачен`, '')),
    ].join(' ');
    return row([
      cell(`<b>${e.date ? esc(fmt.date(e.date)) : 'старт плана'}</b>`),
      cell(`${head}${note ? `<div class="small-note" style="margin:0;">${note}</div>` : ''}`),
      num(`<span class="${e.delta < 0 ? 'neg' : ''}">${e.note?.source === 'start' ? '' : (e.delta > 0 ? '+' : '−')}${esc(fmt.money(Math.abs(e.delta), g.currency_code))}</span>`),
      num(`<b>${esc(fmt.money(e.balance, g.currency_code))}</b>`),
      cell(`${marks}${cur ? `<span class="small-note" style="margin:0;display:block;">${esc(msName(e.phase.idx))}: ${esc(fmt.money(e.phase.saved, g.currency_code))} из ${esc(fmt.money(cur.target, g.currency_code))}</span>`
        : '<span class="small-note" style="margin:0;display:block;">все этапы закрыты</span>'}`),
    ]);
  });

  return `<div class="small-note" style="margin-top:0;">Каждая строка — состояние копилки после движения. Отчисления плана считаются в дату выплаты,
    траты и переводы — в свою дату; этап закрыт, если на его срок денег хватало.</div>
    ${table({ head: ['Дата', 'Движение', { title: 'Сумма', cls: 'num' }, { title: 'В копилке', cls: 'num' }, 'Этапы'], rows })}`;
}

export function render(ctx) {
  const { fmt, ui, state } = ctx;
  const all = goalsOf(ctx);
  if (!all.length) return card({ title: 'История баланса', body: '<div class="muted">Копилок пока нет.</div>' });
  const g = all.find(x => x.id === ui.goal) ?? all[0];
  const txs = state.savings?.goal_transactions ?? [];
  const balance = goalBalanceAt(ctx.sim, g, txs, ctx.today);
  const total = goalTotal(g, state.savings?.goal_milestones ?? []);
  const progress = goalProgressAt(ctx.sim, g, ctx.sim.planEnd || ctx.today);

  return card({
    title: `История баланса: ${g.title}`,
    actions: button({ action: 'ledger-back', value: TAB_OF[g.kind_code] ?? 'goals', label: '← назад', cls: 'ghost small' }),
    body: `
      <div class="row wrap" style="gap:8px;">
        ${all.map(x => button({ action: 'ledger-goal', value: x.id, label: x.title,
          cls: x.id === g.id ? 'small' : 'ghost small', title: KIND_TITLES[x.kind_code] ?? x.kind_code })).join('')}
      </div>
      <div class="row wrap" style="gap:8px;margin-top:12px;">
        ${pill(`на счету сейчас (${fmt.date(ctx.today)}): ${fmt.money(balance, g.currency_code)}`)}
        ${total > 0 ? pill(`засчитано ${fmt.money(progress, g.currency_code)} из ${fmt.money(total, g.currency_code)}`) : ''}
      </div>
      <div style="margin-top:14px;">${ledgerTable(ctx, g)}</div>`,
  });
}

export function handle(ev, ctx) {
  const back = ev.target.closest('[data-ledger-back]');
  if (back) { ctx.ui.tab = back.dataset.ledgerBack; return true; }
  const sel = ev.target.closest('[data-ledger-goal]');
  if (sel) { ctx.ui.goal = sel.dataset.ledgerGoal; return true; }
  return false;
}
