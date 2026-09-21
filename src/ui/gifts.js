/* ---------------------------------------------------------------------
   gifts.js — Подарки: список праздников и план копилки подарков на год.

   Праздники живут только здесь: копилка «Подарки» создаётся сама, удалить
   её нельзя, её этапы и траты собираются из этого списка. Дата праздника —
   одно поле; у повторяющегося из неё берутся только день и месяц.
--------------------------------------------------------------------- */

import { esc, card, table, input, select, addButton, delButton, pill } from './dom.js';
import { uid } from './edit.js';
import { giftAmountForYear } from '../engine/savings.js';
import { milestoneStatus, handle as goalsHandle } from './goals.js';
import { goalBalanceAt } from '../engine/allocation.js';

export const code = 'gifts';
export const title = () => 'Подарки';
export const hasYears = true;

const HOW = `Список праздников разворачивается в копилку «Подарки»: к каждой дате копится своя сумма,
  в эту дату она списывается, а повторяющийся праздник появляется снова в следующем году плана.
  Менять этапы и траты в самой копилке не нужно — они собираются отсюда. Для повторяющегося праздника
  из даты берутся только день и месяц. Разовый праздник учитывается только в своём году.`;

const pad = n => String(n).padStart(2, '0');

/* Дата праздника в выбранном году: у разового — его собственный год */
function eventDate(e, year) {
  if (!e.month || !e.day) return '';
  const y = e.repeat_kind === 'once' ? (e.base_year ?? year) : year;
  return `${y}-${pad(e.month)}-${pad(e.day)}`;
}

export function render(ctx) {
  const { state, fmt, canEdit, sim, year } = ctx;
  const events = (state.gifts?.gift_events ?? [])
    .filter(e => e.repeat_kind !== 'once' || Number(e.base_year) === year)
    .sort((a, b) => (a.month - b.month) || (a.day - b.day));
  const amounts = state.gifts?.gift_event_amounts ?? [];
  const goal = (state.savings?.goals ?? []).find(g => g.kind_code === 'gifts');

  /* ------------------------------------------------------------- праздники */
  const rows = events.map(e => {
    const set = amounts.some(a => a.event_id === e.id && Number(a.year) === year);
    const amount = giftAmountForYear(e.id, amounts, year);
    return `<tr>
      <td>${input({ edit: 'gifts|gift_events|title', key: { id: e.id }, value: e.title, disabled: !canEdit })}</td>
      <td style="width:170px;">${input({ edit: 'gifts|gift_events|day', key: { id: e.id }, value: eventDate(e, year),
        type: 'monthday', disabled: !canEdit })}</td>
      <td style="width:150px;">${input({ edit: 'gifts|gift_event_amounts|amount', key: { event_id: e.id, year },
        value: set ? amount : '', placeholder: fmt.money(amount), type: 'money', disabled: !canEdit })}</td>
      <td style="width:180px;">${select({ edit: 'gifts|gift_events|repeat_kind', key: { id: e.id }, value: e.repeat_kind, disabled: !canEdit,
        options: [{ value: 'yearly', label: 'Каждый год' }, { value: 'once', label: 'Один раз' }] })}</td>
      <td style="width:40px;">${canEdit ? delButton({ domain: 'gifts', table: 'gift_events', key: { id: e.id },
        confirm: `Удалить праздник «${e.title}» вместе с его этапами и тратами?` }) : ''}</td>
    </tr>`;
  });

  const events_ = card({
    title: `Праздники ${year} года`,
    actions: canEdit ? addButton({ domain: 'gifts', table: 'gift_events', cls: 'small', label: '+ праздник',
      row: { id: uid('gift'), goal_id: goal?.id ?? 'goal-gifts', title: 'Новый праздник',
        day: 1, month: 1, repeat_kind: 'yearly', base_year: year, sort_order: events.length + 1 } }) : '',
    body: `<div class="info-box" style="margin-bottom:20px;">${HOW}</div>
      ${table({
        head: ['Праздник', 'Дата', 'Сумма', 'Повтор', ''],
        rows: rows.length ? rows : ['<tr><td colspan="5" class="muted">Праздников пока нет</td></tr>'],
      })}`,
  });

  return `${events_}
    ${giftPlanCard(ctx, goal)}`;
}

/* Праздники года: этапы копилки подарков со сроком в этом году */
export function giftPlan(ctx, goal) {
  const list = (ctx.state.savings?.goal_milestones ?? [])
    .filter(m => m.goal_id === goal?.id && m.source === 'gift' && (m.deadline || '').startsWith(String(ctx.year)))
    .sort((a, b) => ((a.deadline || '') < (b.deadline || '') ? -1 : 1));
  return { list, total: list.reduce((s, m) => s + (Number(m.target) || 0), 0) };
}

/* Таблица плана подарков на год — одна и та же на «Подарках» и на «Обзоре» */
export function giftPlanTable(ctx, goal, { savedThisYear = null } = {}) {
  const { fmt, year } = ctx;
  const { list, total } = giftPlan(ctx, goal);
  const rows = list.map(m => {
    const st = milestoneStatus(ctx, goal, m);
    return `<tr>
      <td>${esc(fmt.date(m.deadline))}</td>
      <td>${esc(m.title)}</td>
      <td class="num">${esc(fmt.money(m.target, goal.currency_code))}</td>
      <td>${pill(st.label, st.cls)}</td>
    </tr>`;
  });
  return table({
    cls: 'tall',
    head: ['Дата', 'Праздник', { title: 'Сумма', cls: 'num' }, 'Статус'],
    rows: rows.length ? rows : [`<tr><td colspan="4" class="muted">В ${year} году праздников нет</td></tr>`],
    foot: rows.length ? `<tr><td colspan="2"><b>Итого за ${year}</b></td>
      <td class="num"><b>${esc(fmt.money(total, goal.currency_code))}</b></td>
      <td>${savedThisYear === null ? '' : pill(`отложим за год ${fmt.money(savedThisYear, goal.currency_code)}`)}</td></tr>` : '',
  });
}

/* Карточка «План на год» с остатком копилки и средней суммой с выплаты */
export function giftPlanCard(ctx, goal) {
  if (!goal) return '';
  const { fmt, sim, state, year } = ctx;
  const { list, total } = giftPlan(ctx, goal);
  const periods = sim.rows.filter(r => Number(r.period.year) === year).length;
  const balance = goalBalanceAt(sim, goal, state.savings?.goal_transactions ?? [], ctx.today);
  return card({
    title: `План на ${year} год`,
    actions: `<span class="small-note" style="margin:0;">в копилке сейчас: ${esc(fmt.money(balance, goal.currency_code))}</span>`,
    body: `${giftPlanTable(ctx, goal)}
      ${!list.length && (ctx.state.gifts?.gift_events ?? []).length
        ? `<div class="small-note">Праздники этого года, которые уже прошли, в план не попадают — к ним копить нечего.
           Посмотрите следующий год кнопками вверху страницы.</div>` : ''}
      ${list.length && periods ? `<div class="small-note">Это ${esc(fmt.money(Math.round(total / periods), goal.currency_code))} в среднем
        с каждой выплаты. Копится не поровну: к каждой дате приложение откладывает столько, чтобы успеть именно к ней.</div>` : ''}`,
  });
}

export const handle = goalsHandle;
