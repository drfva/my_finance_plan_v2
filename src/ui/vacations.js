/* Отпуска и больничные: суммы, формула среднего заработка */

import { esc, card, table, input, checkbox, addButton, delButton, pill } from './dom.js';
import { uid } from './edit.js';

export const code = 'vacations';
export const title = () => 'Отпуска';

export function render(ctx) {
  const { state, fmt, canEdit, income, ui } = ctx;
  const vacations = (state.income?.vacations ?? []).slice().sort((a, b) => ((a.start_date || '') < (b.start_date || '') ? -1 : 1));
  const sick = (state.income?.sick_leaves ?? []).slice().sort((a, b) => ((a.start_date || '') < (b.start_date || '') ? -1 : 1));

  const rows = vacations.map(v => {
    const info = income.vacations.find(x => x.vacation.id === v.id);
    const open = ui.open.has(`vac:${v.id}`);
    const months = info?.formula ? info.formula.months.map(m => `<tr>
      <td>${esc(fmt.month(`${m.y}-${String(m.m).padStart(2, '0')}`))}</td>
      <td class="num">${esc(fmt.money(m.baseIncome))}</td>
      <td class="num">${m.factor !== 1 ? '×' + m.factor.toFixed(3) : ''}</td>
      <td class="num">${m.sickDays || ''}</td>
      <td class="num">${m.coef.toFixed(2)}</td></tr>`).join('') : '';
    return `<tr>
      <td>${input({ edit: 'income|vacations|title', key: { id: v.id }, value: v.title, disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|start_date', key: { id: v.id }, value: v.start_date, type: 'date', disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|end_date', key: { id: v.id }, value: v.end_date, type: 'date', disabled: !canEdit })}</td>
      <td class="num">${esc(info?.formula ? fmt.money(info.formula.amount) : '—')}</td>
      <td class="num">${input({ edit: 'income|vacations|pay_amount', key: { id: v.id }, value: v.pay_amount, type: 'money', disabled: !canEdit || !v.pay_manual, style: 'max-width:130px;text-align:right;' })}</td>
      <td>${checkbox({ edit: 'income|vacations|pay_manual', key: { id: v.id }, value: v.pay_manual, disabled: !canEdit, title: 'Ввести сумму вручную' })}</td>
      <td>${esc(info?.payDate ? fmt.date(info.payDate) : '')}</td>
      <td><button class="ghost small" data-toggle="vac:${esc(v.id)}">${open ? '×' : 'расчёт'}</button></td>
      <td>${canEdit ? delButton({ domain: 'income', table: 'vacations', key: { id: v.id } }) : ''}</td>
    </tr>${open && info?.formula ? `<tr><td colspan="9">
      <div class="small-note">Средний дневной ${esc(fmt.money(info.formula.avgDaily))} × ${info.formula.days} дн.
        Делится по выплатам: ${info.split.map(s => `${esc(fmt.date((state.income.periods.find(p => p.id === s.period_id) || {}).pay_date))} — ${esc(fmt.money(s.amount))}`).join(', ') || 'вне плана'}</div>
      ${table({ head: ['Месяц', { title: 'Доход', cls: 'num' }, { title: 'Индексация', cls: 'num' }, { title: 'Больничный', cls: 'num' }, { title: 'Коэффициент', cls: 'num' }], rows: [months] })}
    </td></tr>` : ''}`;
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
      note: 'Без галочки сумма считается по формуле каждый раз заново.',
      body: table({ head: ['Название', 'С', 'По', { title: 'По формуле', cls: 'num' }, { title: 'Вручную', cls: 'num' }, '', 'Выплата', '', ''],
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
