/* Рассрочки: покупки, график платежей и их привязка к выплатам */

import { esc, card, table, input, select, addButton, delButton, button, pill, field } from './dom.js';
import { uid } from './edit.js';
import { buildInstallmentSchedule } from '../engine/debts.js';

export const code = 'installments';
export const title = () => 'Рассрочки';

export function render(ctx) {
  const { state, fmt, canEdit, sim, ui } = ctx;
  const list = (state.debts?.installments ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const payments = state.debts?.installment_payments ?? [];
  const units = ctx.cfg.list('period_units').map(u => ({ value: u.code, label: u.title }));

  const cards = list.map(i => {
    const own = payments.filter(p => p.installment_id === i.id).sort((a, b) => ((a.pay_date || '') < (b.pay_date || '') ? -1 : 1));
    const paid = own.filter(p => p.pay_date && p.pay_date <= ctx.today);
    const sum = own.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const open = ui.open.has(`inst:${i.id}`);
    const rows = own.map(p => `<div class="item-row ip-row" style="grid-template-columns:1fr 1fr auto auto;align-items:center;">
      ${input({ edit: 'debts|installment_payments|pay_date', key: { id: p.id }, value: p.pay_date, type: 'date', disabled: !canEdit })}
      ${input({ edit: 'debts|installment_payments|amount', key: { id: p.id }, value: p.amount, type: 'money', disabled: !canEdit })}
      <span class="small-note">${esc((sim.rows.find(r => r.installments.some(x => x.date === p.pay_date && x.installments.includes(i.id)))?.period.pay_date ?? '') ? 'из выплаты ' + fmt.date(sim.rows.find(r => r.installments.some(x => x.date === p.pay_date && x.installments.includes(i.id))).period.pay_date) : 'вне плана')}</span>
      ${canEdit ? delButton({ domain: 'debts', table: 'installment_payments', key: { id: p.id } }) : ''}
    </div>`).join('');
    return card({
      body: `
        <div class="row between wrap" style="gap:10px;">
          <div style="flex:2;min-width:180px;">${input({ edit: 'debts|installments|title', key: { id: i.id }, value: i.title, disabled: !canEdit })}</div>
          ${field('Сумма', input({ edit: 'debts|installments|total', key: { id: i.id }, value: i.total, type: 'money', disabled: !canEdit }))}
          ${field('Частей', input({ edit: 'debts|installments|parts', key: { id: i.id }, value: i.parts, type: 'int', disabled: !canEdit }))}
          ${field('Каждые', input({ edit: 'debts|installments|every_n', key: { id: i.id }, value: i.every_n, type: 'int', disabled: !canEdit }))}
          ${field('Единица', select({ edit: 'debts|installments|period_unit', key: { id: i.id }, value: i.period_unit, options: units, disabled: !canEdit }))}
          ${field('Первый платёж', input({ edit: 'debts|installments|first_date', key: { id: i.id }, value: i.first_date, type: 'date', disabled: !canEdit }))}
          ${canEdit ? delButton({ domain: 'debts', table: 'installments', key: { id: i.id }, confirm: `Удалить «${i.title}» вместе с графиком?` }) : ''}
        </div>
        <div class="small-note" style="margin-top:8px;">
          Меняете сумму, число частей или периодичность — график пересобирается на будущие даты, прошедшие платежи остаются.
        </div>
        <div class="small-note" style="margin-top:4px;">
          Оплачено ${paid.length} из ${own.length}, осталось ${esc(fmt.money(own.filter(p => !paid.includes(p)).reduce((s, p) => s + (Number(p.amount) || 0), 0)))}
          ${Math.abs(sum - (Number(i.total) || 0)) > 0.5 ? ` · <b style="color:var(--warn);">сумма платежей ${esc(fmt.money(sum))} ≠ сумме покупки</b>` : ''}
        </div>
        <div class="row wrap" style="gap:8px;margin-top:8px;">
          <button class="ghost small" data-toggle="inst:${esc(i.id)}">${open ? 'свернуть' : 'график платежей'}</button>
          ${canEdit ? button({ action: 'rebuild', value: i.id, label: 'Пересоздать график с нуля', title: 'Все платежи, включая прошедшие, будут созданы заново' }) : ''}
        </div>
        ${open ? `${rows}${canEdit ? addButton({ domain: 'debts', table: 'installment_payments', label: '+ платёж',
          row: { id: uid('ip'), installment_id: i.id, pay_date: ctx.today, amount: 0, paid: false, sort_order: own.length + 1 } }) : ''}` : ''}`,
    });
  }).join('');

  const schedule = sim.rows.filter(r => r.installments.length).map(r => `<tr>
    <td>${esc(fmt.date(r.period.pay_date))}</td>
    <td>${r.installments.map(x => `${esc(fmt.date(x.date))} — ${esc(fmt.money(x.amount))}`).join('<br>')}</td>
    <td class="num">${esc(fmt.money(r.installmentsTotal))}</td></tr>`);

  return `
    <div class="row between wrap" style="gap:8px;">
      ${pill('Платёж оплачивается из последней выплаты не позже его даты')}
      ${canEdit ? addButton({ domain: 'debts', table: 'installments', cls: 'primary small', label: '+ покупка в рассрочку',
        row: { id: uid('inst'), title: 'Новая покупка', total: 0, parts: 4, every_n: 2, period_unit: 'week', first_date: ctx.today, sort_order: list.length + 1 } }) : ''}
    </div>
    ${cards || '<div class="card muted">Рассрочек пока нет.</div>'}
    ${schedule.length ? card({ title: 'Общий график по выплатам', body: table({ head: ['Выплата', 'Платежи', { title: 'Итого', cls: 'num' }], rows: schedule }) }) : ''}`;
}

export function handle(ev, ctx) {
  const btn = ev.target.closest('[data-rebuild]');
  if (!btn) return false;
  const id = btn.dataset.rebuild;
  const inst = ctx.state.debts.installments.find(i => i.id === id);
  if (!window.confirm('Пересоздать график? Ручные правки платежей будут потеряны.')) return false;
  const rows = buildInstallmentSchedule(inst, ctx.cfg.list('period_units'));
  ctx.store.update('debts', d => {
    d.installment_payments = [...(d.installment_payments ?? []).filter(p => p.installment_id !== id), ...rows];
  });
  return true;
}
