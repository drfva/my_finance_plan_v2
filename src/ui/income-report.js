import { esc, card, table } from './dom.js';
import { buildIncomeReport } from '../engine/income-report.js';

export function renderIncomeReport(ctx, report = buildIncomeReport({ state: ctx.state, income: ctx.income ?? ctx.sim.income, year: ctx.year })) {
  const { fmt, year } = ctx;
  const info = (m, kind) => {
    const b = m[kind];
    const label = m.month === 'year' ? `${year} год` : fmt.month(m.month);
    const id = `income-info-${year}-${m.month}-${kind}`;
    const rates = [...b.rates].filter(([, amount]) => amount > 0).sort(([a], [b]) => a - b);
    const rateText = rates.length ? rates.map(([rate, amount]) => `${fmt.percent(rate, 2)} — ${fmt.money(amount)}`).join('; ') : b.tax > 0 ? 'по подтверждённой сумме' : 'не удерживается';
    return `<button class="income-info" popovertarget="${id}" title="Расшифровка дохода"
      aria-label="${esc(`Расшифровка: ${kind === 'automatic' ? 'автоматические выплаты' : 'разовые выплаты'}, ${label}`)}">ⓘ</button>
      <div class="income-popover" id="${id}" popover>
        <b>${esc(label)} · ${kind === 'automatic' ? 'Автоматические выплаты' : 'Разовые выплаты'}</b>
        <dl><dt>Начислено до НДФЛ</dt><dd>${esc(fmt.money(b.gross))}</dd>
        <dt>Ставки НДФЛ${b.manualTax ? ' по расчёту' : ''}</dt><dd>${esc(rateText)}</dd>
        <dt>НДФЛ, всего</dt><dd>${esc(fmt.money(b.tax))}</dd>
        <dt>На руки</dt><dd>${esc(fmt.money(b.net))}</dd></dl>
        ${b.manualTax ? '<p class="small-note">Часть сумм на руки подтверждена вручную; фактический налог учтён в итоге.</p>' : ''}
        ${kind === 'automatic' ? `<p class="small-note">Отдельно по датам поступления ${m.month === 'year' ? 'в этом году' : 'в этом месяце'}. Эти суммы уже учтены в выплатах по расчётным периодам и повторно к доходу не прибавляются.</p>
          <dl><dt>Отпускные на руки</dt><dd>${esc(fmt.money(m.vacation.net))}</dd>
          <dt>Больничный на руки</dt><dd>${esc(fmt.money(m.sick.net))}</dd></dl>
          ${m.missingSickDates > 0 ? `<p class="small-note">Для распределённых сумм больничного ${esc(fmt.money(m.missingSickDates))} не указана дата поступления. Они не включены в справку по фактическим датам.</p>` : ''}` : ''}
      </div>`;
  };
  const money = n => esc(fmt.money(n));
  const cells = m => `${report.slots.map(s => `<td class="num">${money(m.slots.get(s.key) ?? 0)}</td>`).join('')}
    <td class="num"><span class="income-value">${money(m.automatic.net)}${info(m, 'automatic')}</span></td>
    <td class="num"><span class="income-value">${money(m.oneOff.net)}${m.oneOff.tax > 0 ? info(m, 'oneOff') : ''}</span></td>
    <td class="num"><b>${money(m.automatic.net + m.oneOff.net)}</b></td>`;
  return card({ title: `Доход по месяцам ${year}`,
    note: 'Автоматические выплаты показаны по расчётным месяцам, на руки, с распределёнными отпускными и больничным. '
      + 'Разовые — по дате поступления. Названия выплат — из графика выбранного года. Значок ⓘ раскрывает начисления, налог и справку по фактическим датам.',
    body: report.months.length ? table({
      head: ['Месяц', ...report.slots.map(s => ({ title: s.title, cls: 'num' })),
        { title: 'Всего', cls: 'num' }, { title: 'Разовые выплаты', cls: 'num' }, { title: 'Общий доход', cls: 'num' }],
      rows: report.months.map(m => `<tr data-income-month="${m.month}"><td><b>${esc(fmt.month(m.month, { withYear: false }))}</b></td>${cells(m)}</tr>`),
      foot: `<tr><td><b>Итого за год</b></td>${cells(report.totals)}</tr>`,
    }) : '<div class="muted">Выплат в этом году нет.</div>',
  });
}
