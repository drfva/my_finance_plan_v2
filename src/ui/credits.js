/* Кредиты: карты, операции и погашение по плану */

import { esc, card, table, input, select, addButton, delButton, pill, field } from './dom.js';
import { uid } from './edit.js';
import { cardForecast } from '../engine/allocation.js';
import { cycleStatus } from '../engine/debts.js';

export const code = 'credits';
export const title = () => 'Кредиты';

const STATUS = { on_time: ['в срок', 'ok'], late: ['позже срока', 'danger'], beyond_plan: ['срок за пределами плана', 'warn'], unpaid: ['не погашен к сроку', 'danger'] };

/* Прогресс погашения: сколько из набранного в текущем льготном периоде уже отдано */
function repayment(card_, ops, fcState, today) {
  if (!fcState.cycleStart || fcState.debt <= 0.5) return { pct: 100, spent: 0, paid: 0 };
  const spent = ops
    .filter(o => o.card_id === card_.id && o.kind === 'spend' && o.op_date >= fcState.cycleStart && o.op_date <= today)
    .reduce((s, o) => s + Math.abs(Number(o.amount) || 0), 0);
  const paid = Math.max(0, spent - fcState.debt);
  return { pct: spent > 0 ? Math.round(paid / spent * 100) : 0, spent, paid };
}

export function render(ctx) {
  const { state, fmt, canEdit, sim, ui, cfg } = ctx;
  const cards = (state.debts?.credit_cards ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const ops = state.debts?.credit_card_ops ?? [];
  const currencies = [ctx.cfg.get('base_currency'), ...(ctx.cfg.get('extra_currencies') ?? [])].map(c => ({ value: c, label: c }));

  const body = cards.map(c => {
    const fc = cardForecast(sim, c, ops, ctx.today);
    const status = fc.state.debt <= 0.5
      ? pill('долга нет', 'ok')
      : fc.cycle?.closed
        ? pill(`закроется ${fmt.date(fc.cycle.closed)} — ${fc.cycle.closed <= fc.cycle.deadline ? 'в срок' : 'позже срока'}`, fc.cycle.closed <= fc.cycle.deadline ? 'ok' : 'danger')
        : pill(`не успевает закрыться до ${fmt.date(fc.state.deadline)}`, 'danger');
    const own = ops.filter(o => o.card_id === c.id).sort((a, b) => ((a.op_date || '') < (b.op_date || '') ? -1 : 1));
    const opRows = own.map(o => `<div class="item-row op-row" style="grid-template-columns:1fr 1.4fr 1fr 1fr auto;align-items:center;">
      ${input({ edit: 'debts|credit_card_ops|op_date', key: { id: o.id }, value: o.op_date, type: 'date', disabled: !canEdit })}
      ${input({ edit: 'debts|credit_card_ops|title', key: { id: o.id }, value: o.title, disabled: !canEdit })}
      ${select({ edit: 'debts|credit_card_ops|kind', key: { id: o.id }, value: o.kind, disabled: !canEdit,
        options: [{ value: 'spend', label: 'трата' }, { value: 'payment', label: 'погашение вне плана' }] })}
      ${input({ edit: 'debts|credit_card_ops|amount', key: { id: o.id }, value: o.amount, type: 'money', disabled: !canEdit })}
      ${canEdit ? delButton({ domain: 'debts', table: 'credit_card_ops', key: { id: o.id } }) : ''}
    </div>`).join('');

    const payRows = sim.rows.filter(r => (r.debtPayments[c.id] ?? 0) > 0.5).map(r => `<tr>
      <td>${esc(fmt.date(r.period.pay_date))}</td>
      <td class="num">${esc(fmt.money(r.cardBefore[c.id]?.debt ?? 0, c.currency_code))}</td>
      <td class="num">${esc(fmt.money(r.debtPayments[c.id]))}</td>
      <td>${esc(r.cardBefore[c.id]?.deadline ? fmt.date(r.cardBefore[c.id].deadline) : '')}</td></tr>`);

    const cycles = (sim.cardCycles[c.id] ?? []).map(cy => {
      const [label, cls] = STATUS[cycleStatus(cy, sim.planEnd)];
      return `<tr><td>${esc(fmt.date(cy.start))}</td><td>${esc(fmt.date(cy.deadline))}</td>
        <td>${cy.closed ? esc(fmt.date(cy.closed)) : '—'}</td><td>${pill(label, cls)}</td></tr>`;
    });

    const open = ui.open.has(`card:${c.id}`);
    const rep = repayment(c, ops, fc.state, ctx.today);
    return card({
      body: `
        <div class="row between wrap" style="gap:10px;">
          <div style="flex:2;min-width:180px;">${input({ edit: 'debts|credit_cards|title', key: { id: c.id }, value: c.title, disabled: !canEdit })}</div>
          ${field('Лимит', input({ edit: 'debts|credit_cards|credit_limit', key: { id: c.id }, value: c.credit_limit, type: 'money', disabled: !canEdit }))}
          ${field('Льготный период, дней', input({ edit: 'debts|credit_cards|grace_days', key: { id: c.id }, value: c.grace_days, type: 'int', disabled: !canEdit }))}
          ${field('Валюта', select({ edit: 'debts|credit_cards|currency_code', key: { id: c.id }, value: c.currency_code, options: currencies, disabled: !canEdit }))}
          ${canEdit ? delButton({ domain: 'debts', table: 'credit_cards', key: { id: c.id }, confirm: `Удалить карту «${c.title}» с операциями и погашениями?` }) : ''}
        </div>
        <div class="debt-stats row wrap" style="margin-top:10px;">
          <div><div class="v num">${esc(fmt.money(fc.state.debt, c.currency_code))}</div><div class="l">долг сегодня</div></div>
          <div><div class="v num">${esc(fmt.money(Math.max(0, (Number(c.credit_limit) || 0) - fc.state.debt), c.currency_code))}</div><div class="l">доступно</div></div>
          <div><div class="v">${fc.state.deadline ? esc(fmt.date(fc.state.deadline)) : '—'}</div><div class="l">погасить до</div></div>
        </div>
        <div class="progress"><i style="width:${Math.max(0, Math.min(100, rep.pct))}%"></i></div>
        <div class="small-note">${fc.state.debt > 0.5
          ? `Погашено ${esc(fmt.money(rep.paid, c.currency_code))} из ${esc(fmt.money(rep.spent, c.currency_code))} долга текущего периода`
          : 'Долг закрыт'}</div>
        <div class="row wrap" style="gap:8px;margin-top:8px;">${status}
          <button class="ghost small" data-toggle="card:${esc(c.id)}">${open ? 'свернуть' : 'операции и график'}</button></div>
        ${open ? `
          <div class="small-note" style="margin-top:12px;">Операции: трата открывает льготный период, погашение вне плана его закрывает.</div>
          ${opRows}
          ${canEdit ? addButton({ domain: 'debts', table: 'credit_card_ops', label: '+ операция', row: { id: uid('op'), card_id: c.id, op_date: ctx.today, amount: 0, kind: 'spend', title: '', sort_order: own.length + 1 } }) : ''}
          ${payRows.length ? table({ head: ['Выплата', { title: 'Долг до', cls: 'num' }, { title: 'Погашение', cls: 'num' }, 'Срок'], rows: payRows }) : '<div class="small-note">Погашений по плану нет.</div>'}
          ${cycles.length ? table({ head: ['Период с', 'Срок', 'Закрыт', 'Статус'], rows: cycles }) : ''}
        ` : ''}`,
    });
  }).join('');

  const credits = cfg.stages().find(s => s.code === 'credits');
  const settingsCard = card({
    title: 'Как гасим',
    note: 'Обязательная часть считается так, чтобы закрыть долг до конца льготного периода. Что делать с остатком выплаты — решаете здесь.',
    body: field('Остаток выплаты после копилок',
      select({ edit: 'settings|allocation_rules|params', key: { stage_code: 'credits' }, type: 'json',
        value: JSON.stringify(credits?.params?.early_repayment === false ? { early_repayment: false } : { early_repayment: true }),
        options: [
          { value: '{"early_repayment":true}', label: 'гасить карты досрочно' },
          { value: '{"early_repayment":false}', label: 'оставлять свободным' },
        ],
        disabled: !canEdit, defaults: { priority: credits?.priority ?? 4, enabled: true } })),
  });

  return `
    ${settingsCard}
    <div class="row wrap" style="gap:8px;">
      ${pill('Гасим так, чтобы уложиться в льготный период')}
      ${canEdit ? addButton({ domain: 'debts', table: 'credit_cards', cls: 'primary small', label: '+ карта',
        row: { id: uid('card'), title: 'Новая карта', credit_limit: 0, grace_days: 60, currency_code: ctx.cfg.get('base_currency'), sort_order: cards.length + 1 } }) : ''}
    </div>
    ${body || '<div class="card muted">Карт пока нет.</div>'}`;
}
