/* Отпуска и больничные: суммы, формула среднего заработка */

import { esc, card, table, input, checkbox, addButton, delButton, button, pill } from './dom.js';
import { uid } from './edit.js';

export const code = 'vacations';
export const title = () => 'Отпуска';

export function render(ctx) {
  const { state, fmt, canEdit, income, ui } = ctx;
  const vacations = (state.income?.vacations ?? []).slice().sort((a, b) => ((a.start_date || '') < (b.start_date || '') ? -1 : 1));
  const sick = (state.income?.sick_leaves ?? []).slice().sort((a, b) => ((a.start_date || '') < (b.start_date || '') ? -1 : 1));

  const rows = vacations.map(v => {
    const info = income.vacations.find(x => x.vacation.id === v.id);
    const f = info?.formula;
    const open = ui.open.has(`vac:${v.id}`);
    const periodsById = new Map((state.income?.periods ?? []).map(p => [p.id, p]));

    const monthRows = f ? f.months.map(m => `<tr>
      <td>${esc(fmt.month(`${m.y}-${String(m.m).padStart(2, '0')}`))}</td>
      <td class="num">${esc(fmt.money(m.baseIncome))}</td>
      <td class="num">${m.factor !== 1 ? '× ' + m.factor.toFixed(3) : ''}</td>
      <td class="num">${esc(fmt.money(m.income))}</td>
      <td class="num">${m.excludedDays ? `${m.excludedDays}${m.sickDays && m.vacDays ? ` (б ${m.sickDays} + о ${m.vacDays})` : m.sickDays ? ' (больничный)' : ' (отпуск)'}` : ''}</td>
      <td class="num">${m.workedDays} из ${m.days}</td>
      <td class="num">${m.coef.toFixed(2)}</td></tr>`).join('') : '';

    const splitRows = (info?.split ?? []).map(sp => {
      const p = periodsById.get(sp.period_id);
      return `<tr><td>${esc(p ? fmt.date(p.pay_date) : '—')}</td>
        <td>${esc(p?.title || 'выплата')}${p ? ` · за ${esc(fmt.date(p.window_start, 'dayMonth'))}–${esc(fmt.date(p.window_end, 'dayMonth'))}` : ''}</td>
        <td class="num">${sp.days}</td>
        <td class="num">${esc(fmt.money(sp.amount))}</td></tr>`;
    });
    const assigned = (info?.split ?? []).reduce((acc, x) => acc + x.amount, 0);
    const payTotal = info ? info.pay : 0;

    return `<tr>
      <td>${input({ edit: 'income|vacations|title', key: { id: v.id }, value: v.title, disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|start_date', key: { id: v.id }, value: v.start_date, type: 'date', disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|end_date', key: { id: v.id }, value: v.end_date, type: 'date', disabled: !canEdit })}</td>
      <td class="num">${esc(f ? fmt.money(f.amount) : '—')}</td>
      <td class="num">${input({ edit: 'income|vacations|pay_amount', key: { id: v.id }, value: v.pay_manual ? v.pay_amount : (f?.amount ?? ''),
        type: 'money', disabled: !canEdit, style: 'max-width:130px;text-align:right;' })}</td>
      <td>${v.pay_manual
        ? (canEdit ? button({ action: 'vac-formula', value: v.id, label: 'подставить по формуле', cls: 'ghost small',
            title: 'Вернуть сумму, посчитанную по среднему заработку' }) : pill('своя сумма'))
        : pill('по формуле')}</td>
      <td>${esc(info?.payDate ? fmt.date(info.payDate) : '')}</td>
      <td><button class="ghost small" data-toggle="vac:${esc(v.id)}">${open ? 'свернуть' : 'как считалось'}</button></td>
      <td>${canEdit ? delButton({ domain: 'income', table: 'vacations', key: { id: v.id } }) : ''}</td>
    </tr>${open ? `<tr><td colspan="9" style="background:var(--surface-2);">
      ${f ? `
        <div class="small-note" style="margin-top:0;">Расчётный период — 12 календарных месяцев до месяца начала отпуска.
          Полный месяц даёт коэффициент 29,3; месяц с больничным или другим отпуском считается неполным:
          29,3 ÷ дней в месяце × отработанные дни. Отпускные и больничные в доход месяца не входят,
          повышение оклада индексирует более ранние месяцы.</div>
        ${table({ head: ['Месяц', { title: 'Доход', cls: 'num' }, { title: 'Индексация', cls: 'num' },
            { title: 'В расчёт', cls: 'num' }, { title: 'Исключено дней', cls: 'num' },
            { title: 'Отработано', cls: 'num' }, { title: 'Коэффициент', cls: 'num' }],
          rows: [monthRows],
          foot: `<tr><td><b>Итого</b></td><td class="num"></td><td></td>
            <td class="num"><b>${esc(fmt.money(f.totalIncome))}</b></td><td></td><td></td>
            <td class="num"><b>${f.totalCoef.toFixed(2)}</b></td></tr>` })}
        <div class="info-box" style="margin-top:12px;">
          Средний дневной заработок: ${esc(fmt.money(f.totalIncome))} ÷ ${f.totalCoef.toFixed(2)} =
          <b>${esc(fmt.money(f.avgDaily))}</b>.<br>
          Отпускные: ${esc(fmt.money(f.avgDaily))} × ${f.days} ${esc(fmt.plural(f.days, { one: 'календарный день', few: 'календарных дня', many: 'календарных дней' }))} =
          <b>${esc(fmt.money(f.amount))}</b>${v.pay_manual ? ` · в плане стоит своя сумма ${esc(fmt.money(payTotal))}` : ''}.
        </div>` : '<div class="small-note">Укажите даты отпуска — тогда появится расчёт.</div>'}
      <div class="small-note" style="margin-top:14px;">Отпускные добавляются к выплатам по отдельности:
        каждая получает свою часть — по числу дней отпуска, попавших в её расчётный период.</div>
      ${splitRows.length ? table({ head: ['Выплата', 'Расчётный период', { title: 'Дней отпуска', cls: 'num' }, { title: 'Отпускные', cls: 'num' }],
        rows: splitRows,
        foot: `<tr><td colspan="2"><b>Итого</b></td>
          <td class="num"><b>${(info?.split ?? []).reduce((acc, x) => acc + x.days, 0)}</b></td>
          <td class="num"><b>${esc(fmt.money(assigned))}</b></td></tr>` })
        : '<div class="small-note">Отпуск не попал ни в один расчётный период плана — отпускные нигде не учтены.</div>'}
      ${payTotal - assigned > 0.5 ? `<div class="small-note" style="color:var(--warn);">
        ${esc(fmt.money(payTotal - assigned))} остались вне плана: часть отпуска приходится на месяцы без выплат.</div>` : ''}
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
      note: 'По умолчанию сумма считается по формуле каждый раз заново. Введите свою — и появится ссылка «подставить по формуле», чтобы вернуться к расчёту.',
      body: table({ head: ['Название', 'С', 'По', { title: 'По формуле', cls: 'num' }, { title: 'Сумма в плане', cls: 'num' }, 'Откуда', 'Выплата', '', ''],
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
