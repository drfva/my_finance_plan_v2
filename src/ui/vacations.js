/* Отпуска и больничные: суммы, формула среднего заработка */

import { esc, card, table, input, checkbox, addButton, delButton, button, pill } from './dom.js';
import { uid } from './edit.js';

export const code = 'vacations';
export const title = () => 'Отпуска';

export function render(ctx) {
  const { state, fmt, canEdit, income } = ctx;
  const vacations = (state.income?.vacations ?? []).slice().sort((a, b) => ((a.start_date || '') < (b.start_date || '') ? -1 : 1));
  const sick = (state.income?.sick_leaves ?? []).slice().sort((a, b) => ((a.start_date || '') < (b.start_date || '') ? -1 : 1));

  const rows = vacations.map(v => {
    const info = income.vacations.find(x => x.vacation.id === v.id);
    const f = info?.formula;
    const periodsById = new Map((state.income?.periods ?? []).map(p => [p.id, p]));

    return `<tr>
      <td>${input({ edit: 'income|vacations|title', key: { id: v.id }, value: v.title, placeholder: 'Отпуск', disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|start_date', key: { id: v.id }, value: v.start_date, type: 'date', disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|end_date', key: { id: v.id }, value: v.end_date, type: 'date', disabled: !canEdit })}</td>
      <td class="num">${esc(f ? fmt.money(f.amount) : '—')}</td>
      <td class="num">${input({ edit: 'income|vacations|pay_amount', key: { id: v.id }, value: v.pay_manual ? v.pay_amount : (f?.amount ?? ''),
        type: 'money', disabled: !canEdit, cls: v.pay_manual ? 'own' : '', style: 'max-width:130px;text-align:right;' })}</td>
      <td>${v.pay_manual
        ? (canEdit ? button({ action: 'vac-formula', value: v.id, label: 'подставить по формуле', cls: 'ghost small',
            title: 'Вернуть сумму, посчитанную по среднему заработку' }) : pill('своя сумма'))
        : pill('по формуле')}</td>
      <td>${esc(info?.payDate ? fmt.date(info.payDate) : '')}</td>
      <td class="small-note">${(info?.split ?? []).map(sp => {
        const pp = periodsById.get(sp.period_id);
        return `${esc(pp ? fmt.date(pp.pay_date, 'dayMonth') : '—')} — ${esc(fmt.money(sp.amount))} (${sp.days} дн.)`;
      }).join('<br>')}</td>
      <td>${canEdit ? delButton({ domain: 'income', table: 'vacations', key: { id: v.id } }) : ''}</td>
    </tr>`;
  });

  const sickRows = sick.map(s => `<tr>
    <td>${input({ edit: 'income|sick_leaves|start_date', key: { id: s.id }, value: s.start_date, type: 'date', disabled: !canEdit })}</td>
    <td>${input({ edit: 'income|sick_leaves|end_date', key: { id: s.id }, value: s.end_date, type: 'date', disabled: !canEdit })}</td>
    <td>${input({ edit: 'income|sick_leaves|note', key: { id: s.id }, value: s.note, disabled: !canEdit })}</td>
    <td>${canEdit ? delButton({ domain: 'income', table: 'sick_leaves', key: { id: s.id } }) : ''}</td></tr>`);

  return `
    <div class="row wrap" style="gap:8px;">
      ${pill('Дни отпуска и больничного окладом не оплачиваются: за отпуск идут отпускные')}
    </div>
    ${card({
      title: 'Отпуска',
      actions: canEdit ? addButton({ domain: 'income', table: 'vacations', label: '+ отпуск',
        row: { id: uid('vac'), title: 'Отпуск', start_date: `${ctx.year}-06-01`, end_date: `${ctx.year}-06-14`, pay_amount: 0, pay_manual: false } }) : '',
      note: 'Сумма считается по среднему заработку за 12 месяцев и делится между выплатами по дням отпуска, попавшим в их расчётные периоды. '
        + 'Введите свою — появится ссылка «подставить по формуле», чтобы вернуться к расчёту.',
      body: table({ head: ['Название', 'С', 'По', { title: 'По формуле', cls: 'num' }, { title: 'Сумма в плане', cls: 'num' },
          'Откуда', 'Выплата', 'Как делится', ''],
        rows: rows.length ? rows : ['<tr><td colspan="9" class="muted">Отпусков нет</td></tr>'] }),
    })}
    ${card({
      title: 'Больничные',
      actions: canEdit ? addButton({ domain: 'income', table: 'sick_leaves', label: '+ больничный',
        row: { id: uid('sick'), start_date: ctx.today, end_date: ctx.today, note: '' } }) : '',
      note: 'Уменьшают коэффициент месяца в расчёте среднего заработка.',
      body: table({ head: ['С', 'По', 'Комментарий', ''], rows: sickRows.length ? sickRows : ['<tr><td colspan="4" class="muted">Больничных нет</td></tr>'] }),
    })}`;
}

export function handle(ev, ctx) {
  const { store, income } = ctx;
  const el = ev.target.closest('[data-vac-formula]');
  if (!el) return false;
  const id = el.dataset.vacFormula;
  const f = income.vacations.find(x => x.vacation.id === id)?.formula;
  store.update('income', d => {
    const v = (d.vacations ?? []).find(x => x.id === id);
    if (!v) return;
    v.pay_manual = false;
    v.pay_amount = f ? f.amount : 0;
  });
  return true;
}
