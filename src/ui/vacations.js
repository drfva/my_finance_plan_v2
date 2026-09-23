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
    const periodsById = new Map((state.income?.periods ?? []).map(p => [p.id, p]));
    const open = ui.open.has(`vac:${v.id}`);
    // начислено и на руки собираем из выплат, куда попал отпуск
    const parts = (info?.split ?? []).map(sp => {
      const row = income.byId.get(sp.period_id);
      const own = (row?.vacations ?? []).find(x => x.vacation_id === v.id);
      return { ...sp, period: periodsById.get(sp.period_id), net: own?.net ?? 0 };
    });
    const gross = parts.reduce((acc, x) => acc + x.amount, 0);
    const net = parts.reduce((acc, x) => acc + x.net, 0);

    return `<tr>
      <td>${input({ edit: 'income|vacations|title', key: { id: v.id }, value: v.title, placeholder: 'Отпуск', disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|start_date', key: { id: v.id }, value: v.start_date, type: 'date', disabled: !canEdit })}</td>
      <td>${input({ edit: 'income|vacations|end_date', key: { id: v.id }, value: v.end_date, type: 'date', disabled: !canEdit })}</td>
      <td class="num">${esc(f ? fmt.money(f.amount) : '—')}</td>
      <td class="num">${input({ edit: 'income|vacations|pay_amount', key: { id: v.id }, value: v.pay_manual ? v.pay_amount : (f?.amount ?? ''),
        type: 'money', disabled: !canEdit, cls: v.pay_manual ? 'own' : '', style: 'max-width:130px;text-align:right;' })}</td>
      <td class="num"><b>${esc(fmt.money(net))}</b></td>
      <td>${v.pay_manual
        ? (canEdit ? button({ action: 'vac-formula', value: v.id, label: 'по формуле', cls: 'ghost small',
            title: 'Вернуть сумму, посчитанную по среднему заработку' }) : pill('своя сумма'))
        : pill('по формуле')}</td>
      <td>${esc(info?.payDate ? fmt.date(info.payDate) : '')}</td>
      <td><button class="ghost small" data-toggle="vac:${esc(v.id)}">${open ? 'свернуть' : 'как считаем'}</button></td>
      <td>${canEdit ? delButton({ domain: 'income', table: 'vacations', key: { id: v.id } }) : ''}</td>
    </tr>
    ${open ? `<tr><td colspan="10" style="background:var(--surface-2);">${howCalculated(ctx, v, f, parts, { gross, net })}</td></tr>` : ''}`;
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
      note: 'Считаем по Положению № 922: средний дневной заработок из начисленных сумм за 12 месяцев, потом НДФЛ — и получается «на руки». '
        + 'Своя сумма вписывается тоже начисленной. Деньги делятся между выплатами по дням отпуска в их расчётных периодах, '
        + 'а фактически приходят одной суммой в дату из колонки «Выплатят».',
      body: table({ head: ['Название', 'С', 'По',
          { title: 'Начислено по формуле', cls: 'num' }, { title: 'Начислено в плане', cls: 'num' }, { title: 'На руки', cls: 'num' },
          'Откуда', 'Выплатят', '', ''],
        rows: rows.length ? rows : ['<tr><td colspan="10" class="muted">Отпусков нет</td></tr>'] }),
    })}
    ${card({
      title: 'Больничные',
      actions: canEdit ? addButton({ domain: 'income', table: 'sick_leaves', label: '+ больничный',
        row: { id: uid('sick'), start_date: ctx.today, end_date: ctx.today, note: '' } }) : '',
      note: 'Уменьшают коэффициент месяца в расчёте среднего заработка.',
      body: table({ head: ['С', 'По', 'Комментарий', ''], rows: sickRows.length ? sickRows : ['<tr><td colspan="4" class="muted">Больничных нет</td></tr>'] }),
    })}`;
}

/* Как считаем: 12 месяцев в gross → СДЗ → начислено → НДФЛ → на руки */
function howCalculated(ctx, v, f, parts, totals) {
  const { fmt } = ctx;
  if (!f) return '<div class="small-note">Укажите даты отпуска — появится расчёт.</div>';

  const monthRows = f.months.map(m => `<tr>
    <td>${esc(fmt.month(`${m.y}-${String(m.m).padStart(2, '0')}`))}</td>
    <td class="num">${esc(fmt.money(m.baseIncome))}</td>
    <td class="num">${m.factor !== 1 ? '× ' + m.factor.toFixed(3) : ''}</td>
    <td class="num">${esc(fmt.money(m.income))}</td>
    <td class="num">${m.excludedDays ? `${m.excludedDays}${m.sickDays && m.vacDays ? ` (б ${m.sickDays} + о ${m.vacDays})` : m.sickDays ? ' (больничный)' : ' (отпуск)'}` : ''}</td>
    <td class="num">${m.workedDays} из ${m.days}</td>
    <td class="num">${m.coef.toFixed(2)}</td></tr>`).join('');

  const partRows = parts.map(x => `<tr>
    <td>${esc(x.period ? fmt.date(x.period.pay_date) : '—')}</td>
    <td>${esc(x.period?.title || 'выплата')}${x.period ? ` · за ${esc(fmt.date(x.period.window_start, 'dayMonth'))}–${esc(fmt.date(x.period.window_end, 'dayMonth'))}` : ''}</td>
    <td class="num">${x.days}</td>
    <td class="num">${esc(fmt.money(x.amount))}</td>
    <td class="num">${esc(fmt.money(x.net))}</td></tr>`);

  const tax = totals.gross - totals.net;
  return `
    <div class="small-note" style="margin-top:0;">Расчётный период — 12 календарных месяцев до месяца начала отпуска.
      В заработок идут оклад и премии до налога; отпускные, больничные и подарки — нет.
      Полный месяц даёт 29,3 дня, месяц с больничным или другим отпуском — 29,3 ÷ дней в месяце × отработанные дни.
      Повышение оклада «для всех» индексирует более ранние месяцы.</div>
    ${table({ head: ['Месяц', { title: 'Начислено', cls: 'num' }, { title: 'Индексация', cls: 'num' },
        { title: 'В расчёт', cls: 'num' }, { title: 'Исключено дней', cls: 'num' },
        { title: 'Отработано', cls: 'num' }, { title: 'Коэффициент', cls: 'num' }],
      rows: [monthRows],
      foot: `<tr><td><b>Итого</b></td><td class="num"></td><td></td>
        <td class="num"><b>${esc(fmt.money(f.totalIncome))}</b></td><td></td><td></td>
        <td class="num"><b>${f.totalCoef.toFixed(2)}</b></td></tr>` })}
    <div class="info-box" style="margin-top:12px;">
      Средний дневной заработок: ${esc(fmt.money(f.totalIncome))} ÷ ${f.totalCoef.toFixed(2)} = <b>${esc(fmt.money(f.avgDaily))}</b><br>
      Начислено: ${esc(fmt.money(f.avgDaily))} × ${f.days} ${esc(fmt.plural(f.days, { one: 'день', few: 'дня', many: 'дней' }))} =
        <b>${esc(fmt.money(v.pay_manual ? Number(v.pay_amount) || 0 : f.amount))}</b>${v.pay_manual ? ' (своя сумма)' : ''}<br>
      НДФЛ: <b>${esc(fmt.money(tax))}</b> · на руки: <b>${esc(fmt.money(totals.net))}</b>
    </div>
    <div class="small-note" style="margin-top:14px;">Деньги приходят одной суммой
      ${ctx.income.vacations.find(x => x.vacation.id === v.id)?.payDate
        ? `<b>${esc(fmt.date(ctx.income.vacations.find(x => x.vacation.id === v.id).payDate))}</b>` : 'перед отпуском'},
      а в плане делятся между выплатами по дням отпуска, попавшим в их расчётные периоды.</div>
    ${partRows.length ? table({ head: ['Выплата', 'Расчётный период', { title: 'Дней', cls: 'num' },
        { title: 'Начислено', cls: 'num' }, { title: 'На руки', cls: 'num' }], rows: partRows })
      : '<div class="small-note">Отпуск не попал ни в один расчётный период плана.</div>'}`;
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
