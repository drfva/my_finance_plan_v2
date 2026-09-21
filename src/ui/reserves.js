/* Подушки: накопления без оборота, со своим темпом за выплату */

import { esc, addButton, pill, field, input, card, table } from './dom.js';
import { uid } from './edit.js';
import { goalCard, handle as goalsHandle } from './goals.js';
import { reservePaceSuggestion } from '../engine/allocation.js';

export const code = 'reserves';
export const title = () => 'Подушки';

export function render(ctx) {
  const { state, fmt, canEdit, sim } = ctx;
  const goals = (state.savings?.goals ?? []).filter(g => g.kind_code === 'reserve')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  const cards = goals.map(g => {
    const s = reservePaceSuggestion(sim, g, ctx.today);
    const hint = s.payoutsLeft
      ? `Чтобы успеть к сроку этапа, нужно ${esc(fmt.money(s.needPer, g.currency_code))} с выплаты (осталось ${s.payoutsLeft}).
         В будущих выплатах в среднем свободно ${esc(fmt.money(s.avgFree))}.
         ${s.enough ? 'Хватает.' : '<b>Не хватает — к сроку не успеет.</b>'}`
      : 'У текущего этапа нет срока — подушка копится своим темпом.';
    const extra = `<div class="grid cols-2" style="margin-top:10px;">
      ${field('Темп за выплату', input({ edit: 'savings|goals|pace_amount', key: { id: g.id }, value: g.pace_amount, type: 'money', disabled: !canEdit }),
        'Сколько подушка забирает с каждой выплаты до того, как остаток пойдёт дальше')}
      ${field('Предложение', `<div class="num" style="padding-top:8px;">${esc(fmt.money(s.suggested))}</div>`, 'Меньшее из «нужно к сроку» и «в среднем свободно»')}
    </div>
    <div class="small-note">${hint}</div>`;
    return goalCard(ctx, g, { extraFields: extra });
  }).join('');

  return `
    <div class="row between wrap" style="gap:8px;">
      ${pill('Подушка получает свой темп за выплату, а после копилок — остаток')}
      ${canEdit ? addButton({ domain: 'savings', table: 'goals', cls: 'primary small', label: '+ подушка', row: { id: uid('goal'), title: 'Новая подушка', kind_code: 'reserve', currency_code: ctx.cfg.get('base_currency'), priority: goals.length + 1, target_amount: 0, starting_balance: 0, pace_amount: 0, completed: false } }) : ''}
    </div>
    ${cards || '<div class="card muted">Подушек пока нет.</div>'}`;
}

export const handle = goalsHandle;
