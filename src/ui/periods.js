/* Доходы: выплаты года, их расчёт и ручные правки */

import { esc, card, table, pill, input, field, button, delButton, select } from './dom.js';
import { uid } from './edit.js';
import { freezePeriods } from '../engine/allocation.js';
import { generateYear } from '../engine/income.js';

export const code = 'periods';
export const title = () => 'Доходы';
export const hasYears = true;

const defaultDraft = ctx => ({ pay_date: ctx.today, income_net: '', note: '', window: ctx.today.slice(0, 7) });

/* Годы, где график задан, а выплат ещё нет: их можно создать одной кнопкой */
function yearsWithSchedule(ctx) {
  const inc = ctx.state.income ?? {};
  return [...new Set((inc.payout_slots ?? []).map(s => Number(s.year)))]
    .filter(y => Number.isFinite(y) && !(inc.periods ?? []).some(p => Number(p.year) === y))
    .sort();
}

function head(ctx, r) {
  const { fmt } = ctx;
  const p = r.period;
  const debts = Object.values(r.debtPayments).reduce((s, x) => s + x, 0);
  const pills = [
    p.calc_mode === 'manual' ? pill('вручную') : '',
    p.locked ? pill('🔒 зафиксирована') : '',
    r.income.vacationPay > 0.5 ? pill(`отпускные ${fmt.money(r.income.vacationPay)}`) : '',
    r.income.extraIncome > 0.5 ? pill(`разовый доход ${fmt.money(r.income.extraIncome)}`) : '',
    debts > 0.5 ? pill(`долги ${fmt.money(debts)}`) : '',
    r.free < -0.5 ? pill('дефицит', 'danger') : (r.unallocated < -0.5 ? pill(`не хватает ${fmt.money(-r.unallocated)}`, 'warn') : ''),
    r.unallocated > 0.5 ? pill(`+${fmt.money(r.unallocated)} свободно`, 'ok') : '',
  ].filter(Boolean).join(' ');
  return `<div class="period-head" data-toggle="period:${esc(p.id)}">
    <div class="period-date"><b>${esc(fmt.date(p.pay_date))}</b><div class="small-note">${esc(p.title || (p.slot_order ? `выплата ${p.slot_order}` : 'разовая'))} · за ${esc(fmt.date(p.window_start, 'dayMonth'))}–${esc(fmt.date(p.window_end, 'dayMonth'))}</div></div>
    <div class="row wrap" style="gap:6px;flex:1;">${pills}</div>
    <div class="num">${esc(fmt.money(r.totalIncome))}</div>
    <div class="num muted">−${esc(fmt.money(r.categoriesTotal + r.installmentsTotal))}</div>
    <div class="num"><b>${esc(fmt.money(r.free))}</b></div>
    <span class="chev">›</span>
  </div>`;
}

function body(ctx, r) {
  const { fmt, state, canEdit } = ctx;
  const p = r.period;
  const f = r.income.formula;
  const cats = state.expenses?.expense_categories ?? [];
  const goals = state.savings?.goals ?? [];
  const cards = state.debts?.credit_cards ?? [];

  const catRows = r.expenses.categories.filter(c => c.amount || c.planned).map(c => {
    const cat = cats.find(x => x.id === c.category_id);
    return `<tr>
      <td>${esc(cat?.title ?? c.category_id)}${c.mode === 'percent_income' ? ' <span class="small-note">процент</span>' : ''}</td>
      <td class="num muted">${esc(fmt.money(c.planned))}</td>
      <td class="num">${input({ edit: 'expenses|expense_period_overrides|amount', key: { period_id: p.id, category_id: c.category_id },
        value: fmt.round(c.amount), type: 'money', disabled: !canEdit, cls: c.overridden ? 'own' : '',
        style: 'max-width:130px;text-align:right;' })}</td>
    </tr>`;
  });

  const instRows = r.installments.map(x => `<tr><td>${esc(fmt.date(x.date))}</td>
    <td>${esc(x.installments.map(id => (state.debts?.installments ?? []).find(i => i.id === id)?.title ?? id).join(', '))}</td>
    <td class="num">${esc(fmt.money(x.amount))}</td></tr>`);

  const cardRows = cards.map(c => {
    const before = r.cardBefore[c.id];
    const paid = r.debtPayments[c.id] ?? 0;
    const ov = (state.debts?.credit_payment_overrides ?? []).some(o => o.period_id === p.id && o.card_id === c.id);
    return `<tr>
      <td>${esc(c.title)}</td>
      <td class="num muted">${esc(fmt.money(before?.debt ?? 0, c.currency_code))}</td>
      <td class="muted">${before?.deadline ? esc(fmt.date(before.deadline)) : '—'}</td>
      <td class="num">${input({ edit: 'debts|credit_payment_overrides|amount', key: { period_id: p.id, card_id: c.id },
        value: fmt.round(paid), type: 'money', disabled: !canEdit, cls: ov ? 'own' : '', style: 'max-width:130px;text-align:right;' })}</td>
    </tr>`;
  });

  const ovRows = state.savings?.savings_period_overrides ?? [];
  const hasCatOverrides = (state.expenses?.expense_period_overrides ?? []).some(o => o.period_id === p.id);
  const hasCardOverrides = (state.debts?.credit_payment_overrides ?? []).some(o => o.period_id === p.id);
  // закрытая цель остаётся только в зафиксированных выплатах и там, где ей уже что-то досталось
  const goalRow = g => {
    const amount = r.allocations[g.id] ?? 0;
    const own = ovRows.some(o => o.period_id === p.id && o.goal_id === g.id);
    return `<tr>
      <td>${esc(g.title)}</td>
      <td class="num muted">${esc(fmt.money(amount))}</td>
      <td class="num">${input({ edit: 'savings|savings_period_overrides|amount', key: { period_id: p.id, goal_id: g.id },
        value: fmt.round(amount), type: 'money', disabled: !canEdit, cls: own ? 'own' : '',
        style: 'max-width:130px;text-align:right;' })}</td>
      <td class="num muted">${esc(fmt.money(r.goalBalances[g.id] ?? 0, g.currency_code))}</td>
    </tr>`;
  };
  // закрытая цель остаётся только в зафиксированных выплатах и там, где ей уже что-то досталось
  const visibleGoals = goals.filter(g => !g.completed || p.locked || (r.allocations[g.id] ?? 0) > 0.5);
  const goalsOf = kind => visibleGoals.filter(g => (kind === 'reserve' ? g.kind_code === 'reserve' : g.kind_code !== 'reserve'))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  const savingsCard = (title_, kind) => {
    const list = goalsOf(kind);
    if (!list.length) return '';
    const own = list.some(g => ovRows.some(o => o.period_id === p.id && o.goal_id === g.id));
    return card({
      title: title_,
      actions: !canEdit ? '' : own
        ? button({ action: 'reset-savings', value: `${p.id}:${kind}`, label: p.locked ? 'Обнулить суммы' : 'Сбросить на авто-расчёт' })
        : button({ action: 'clear-savings', value: `${p.id}:${kind}`, label: 'Очистить поля' }),
      note: p.locked ? 'Выплата зафиксирована: идут только эти суммы.'
        : own ? 'Свои суммы закреплены, остальное план пересчитал под них.'
        : 'В поле — сумма, которую посчитал план. Впишите свою: она закрепится, остальные пересчитаются.',
      body: table({ head: ['Цель', { title: 'Авто-расчёт', cls: 'num' }, { title: 'В расчёте', cls: 'num' }, { title: 'В копилке', cls: 'num' }],
        rows: list.map(goalRow) }),
    });
  };

  const remainder = r.unallocated >= -0.5
    ? `<div class="info-box" style="${r.unallocated > 0.5 ? 'background:var(--good-soft);color:var(--good);' : ''}">
        Свободные деньги: <b class="num">${r.unallocated > 0.5 ? '+' : ''}${esc(fmt.money(r.unallocated))}</b>
        ${r.unallocated > 0.5 ? ' — их можно раздать копилкам или оставить себе.' : ''}</div>`
    : `<div class="info-box" style="background:var(--danger-soft);color:var(--danger);">
        Свободный остаток: <b class="num">${esc(fmt.money(r.unallocated))}</b>.
        ${r.free < -0.5 ? 'Расходы превышают доход выплаты — распределять в копилки нечего.'
          : `После расходов оставалось ${esc(fmt.money(r.free))}, а распределено больше.`}</div>`;

  return `<div class="period-body">
    <div class="row wrap" style="gap:8px;margin-bottom:12px;">
      ${canEdit ? (p.locked
        ? button({ action: 'unlock', value: p.id, label: '🔓 Разблокировать' })
        : button({ action: 'freeze', value: p.id, label: '🔒 Зафиксировать' })) : ''}
      ${canEdit && p.calc_mode === 'manual' ? delButton({ domain: 'income', table: 'periods', key: { id: p.id }, label: 'Удалить выплату', cls: 'ghost small', confirm: 'Удалить эту выплату вместе с её ручными суммами?' }) : ''}

    </div>

    <div class="grid cols-3">
      ${field('Дата выплаты', input({ edit: 'income|periods|pay_date', key: { id: p.id }, value: p.pay_date, type: 'date', disabled: !canEdit }))}
      <div class="field"><label>Доход на руки</label>
        ${input({ edit: 'income|periods|income_net', key: { id: p.id }, value: p.income_net, type: 'money', disabled: !canEdit })}
        <div class="small-note">${f
          ? `${esc(fmt.money(f.net))} по формуле: ${f.workedDays} из ${f.windowDays} рабочих дней,
             начислено ${esc(fmt.money(f.gross))}, налог ${esc(fmt.money(f.tax))}
             ${canEdit && Math.abs((Number(p.income_net) || 0) - f.net) > 0.5
               ? button({ action: 'fill-income', value: p.id, label: 'подставить по формуле', cls: 'ghost small' }) : ''}`
          : 'оклада на этот период нет'}</div>
        ${r.income.vacationPay > 0.5 ? `<div class="small-note">+ отпускные ${esc(fmt.money(r.income.vacationPay))}
          за ${r.income.vacations.reduce((sum, x) => sum + x.days, 0)} дн., считаются на вкладке «Отпуска»</div>` : ''}
        ${r.income.extraIncome > 0.5 ? `<div class="small-note">+ разовый доход ${esc(fmt.money(r.income.extraIncome))}</div>` : ''}
      </div>
      ${field('Комментарий', input({ edit: 'income|periods|note', key: { id: p.id }, value: p.note, disabled: !canEdit }))}
    </div>

    ${r.income.vacationPay ? `<div class="small-note">Отпускные в этой выплате: ${r.income.vacations.map(v =>
      `${esc((state.income?.vacations ?? []).find(x => x.id === v.vacation_id)?.title || 'отпуск')} — ${esc(fmt.money(v.amount))} (${v.days} дн.)`).join(', ')}</div>` : ''}
    ${r.income.extraIncome ? `<div class="small-note">Разовый доход: ${esc(fmt.money(r.income.extraIncome))}</div>` : ''}

    <div class="grid cols-2" style="margin-top:20px;">
      ${card({
        title: 'Расходы по категориям',
        actions: !canEdit ? '' : (hasCatOverrides
          ? button({ action: 'reset-categories', value: p.id, label: 'Подставить по шаблону' })
          : button({ action: 'clear-categories', value: p.id, label: 'Очистить поля' })),
        note: 'В поле — сумма, которая идёт в расчёт. Впишите свою, чтобы поменять её только в этой выплате.',
        body: table({ head: ['Категория', { title: 'По шаблону', cls: 'num' }, { title: 'В расчёте', cls: 'num' }],
          rows: catRows.length ? catRows : ['<tr><td colspan="3" class="muted">Категорий нет</td></tr>'] }),
      })}
      ${savingsCard('Распределение по копилкам', 'bucket')}
      ${savingsCard('Распределение по подушкам', 'reserve')}
    </div>
    ${instRows.length ? `<div style="margin-top:20px;">${card({ title: 'Рассрочки из этой выплаты', body: table({ head: ['Дата', 'Покупка', { title: 'Сумма', cls: 'num' }], rows: instRows }) })}</div>` : ''}
    ${cardRows.length ? `<div style="margin-top:20px;">${card({
      title: 'Кредитки',
      actions: canEdit && hasCardOverrides ? button({ action: 'reset-cards', value: p.id, label: 'Сбросить на авто-расчёт' }) : '',
      body: table({ head: ['Карта', { title: 'Долг до выплаты', cls: 'num' }, 'Погасить до', { title: 'В расчёте', cls: 'num' }], rows: cardRows }),
    })}</div>` : ''}
    <div style="margin-top:20px;">${remainder}</div>
  </div>`;
}

/* Кнопка раздела: рисуется оболочкой рядом с кнопками годов */
export function actions(ctx) {
  return ctx.canEdit ? button({ action: 'open-add', label: '+ выплата', cls: 'primary small' }) : '';
}

export function render(ctx) {
  const { sim, ui, year, fmt, canEdit, state } = ctx;
  const rows = sim.rows.filter(r => Number(r.period.year) === year);
  const past = rows.filter(r => r.period.pay_date <= ctx.today);
  const future = rows.filter(r => r.period.pay_date > ctx.today);
  const visible = [...past.slice(-1), ...future];
  const hidden = past.length - 1;

  const cardsHtml = visible.map(r => {
    const open = ui.open.has(`period:${r.period.id}`);
    return `<div class="period-card${open ? ' open' : ''}${r.period.pay_date <= ctx.today ? ' past' : ''}">
      ${head(ctx, r)}${open ? body(ctx, r) : ''}</div>`;
  }).join('');

  const showPast = hidden > 0
    ? `<button class="past-toggle" data-toggle="past">${ui.open.has('past')
        ? 'Скрыть прошедшие выплаты' : `Показать прошедшие выплаты (${hidden})`}</button>` : '';
  const pastHtml = ui.open.has('past') ? past.slice(0, -1).map(r => {
    const open = ui.open.has(`period:${r.period.id}`);
    return `<div class="period-card past${open ? ' open' : ''}">${head(ctx, r)}${open ? body(ctx, r) : ''}</div>`;
  }).join('') : '';

  const draft = { ...defaultDraft(ctx), ...(ui.draft.periods ?? {}) };
  const form = canEdit && ui.open.has('add-period') ? `
    <div class="modal-back" data-close-add>
      <div class="modal card" data-modal>
        <div class="card-title"><h2>Новая выплата</h2>
          <button class="ghost small" data-close-add title="Закрыть">✕</button></div>
        <div class="small-note" style="margin-top:0;">Премия, подработка, выплата вне графика.
          Расчётный период — месяц, к которому она относится.</div>
        <div class="grid cols-2" style="margin-top:14px;">
          ${field('Дата выплаты', `<input type="date" data-draft="pay_date" value="${esc(draft.pay_date)}">`)}
          ${field('За месяц', `<input type="month" data-draft="window" value="${esc(draft.window)}">`)}
          ${field('Доход на руки', `<input class="num" inputmode="decimal" data-draft="income_net" value="${esc(draft.income_net)}">`)}
          ${field('Комментарий', `<input data-draft="note" value="${esc(draft.note)}">`)}
        </div>
        <div class="row wrap" style="gap:8px;margin-top:16px;">
          ${button({ action: 'add-manual', label: 'Создать выплату', cls: 'primary small' })}
          ${button({ action: 'close-add', label: 'Отмена', cls: 'ghost small' })}
        </div>
      </div>
    </div>` : '';

  const generate = canEdit && yearsWithSchedule(ctx).length ? `<div class="row wrap" style="gap:8px;">
    ${yearsWithSchedule(ctx).map(y => button({ action: 'generate-year', value: y, label: `Создать выплаты ${y} года по графику` })).join(' ')}
  </div>` : '';

  const emptyNote = yearsWithSchedule(ctx).length
    ? 'Выплат за этот год нет, но график задан — создайте их кнопкой ниже.'
    : 'Выплат за этот год нет. Сначала задайте график выплат в настройках: год, числа выплат и расчётные периоды.';
  return `${showPast}${pastHtml}${cardsHtml || `<div class="card muted">${emptyNote}</div>`}${generate}${form}`;
}

/* Кнопки вкладки. Возвращает true, если экран нужно перерисовать сразу. */
export function handle(ev, ctx) {
  const { store, ui, fmt } = ctx;

  const freeze = ev.target.closest('[data-freeze]');
  if (freeze) {
    const patch = freezePeriods(ctx.state, ctx.sim, [freeze.dataset.freeze], fmt.round);
    store.update('income', d => { d.periods = patch.periods; });
    store.update('savings', d => { d.savings_period_overrides = patch.savings_period_overrides; });
    store.update('debts', d => { d.credit_payment_overrides = patch.credit_payment_overrides; });
    return false;
  }

  const unlock = ev.target.closest('[data-unlock]');
  if (unlock) {
    store.update('income', d => {
      const p = d.periods.find(x => x.id === unlock.dataset.unlock);
      if (p) p.locked = false;
    });
    return false;
  }

  /* цели выплаты по типу: копилки и подарки отдельно от подушек */
  const goalsOfKind = kind => (ctx.state.savings?.goals ?? [])
    .filter(g => (kind === 'reserve' ? g.kind_code === 'reserve' : g.kind_code !== 'reserve'));

  const reset = ev.target.closest('[data-reset-savings]');
  if (reset) {
    const [id, kind] = reset.dataset.resetSavings.split(':');
    const ids = new Set(goalsOfKind(kind).map(g => g.id));
    store.update('savings', d => {
      d.savings_period_overrides = (d.savings_period_overrides ?? [])
        .filter(o => !(o.period_id === id && ids.has(o.goal_id)));
    });
    return false;
  }

  // очистить поля: всем целям этого блока ставим свою сумму 0 — дальше вписывайте руками
  const clear = ev.target.closest('[data-clear-savings]');
  if (clear) {
    const [id, kind] = clear.dataset.clearSavings.split(':');
    const list = goalsOfKind(kind);
    store.update('savings', d => {
      const rows = d.savings_period_overrides ?? (d.savings_period_overrides = []);
      for (const g of list) {
        const own = rows.find(o => o.period_id === id && o.goal_id === g.id);
        if (own) own.amount = 0;
        else rows.push({ period_id: id, goal_id: g.id, amount: 0 });
      }
    });
    return false;
  }

  const resetCats = ev.target.closest('[data-reset-categories]');
  if (resetCats) {
    const id = resetCats.dataset.resetCategories;
    store.update('expenses', d => { d.expense_period_overrides = (d.expense_period_overrides ?? []).filter(o => o.period_id !== id); });
    return false;
  }

  const clearCats = ev.target.closest('[data-clear-categories]');
  if (clearCats) {
    const id = clearCats.dataset.clearCategories;
    const row = ctx.sim.byId.get(id);
    store.update('expenses', d => {
      const rows = d.expense_period_overrides ?? (d.expense_period_overrides = []);
      for (const c of row?.expenses.categories ?? []) {
        const own = rows.find(o => o.period_id === id && o.category_id === c.category_id);
        if (own) own.amount = 0;
        else rows.push({ period_id: id, category_id: c.category_id, amount: 0 });
      }
    });
    return false;
  }

  const resetCards = ev.target.closest('[data-reset-cards]');
  if (resetCards) {
    const id = resetCards.dataset.resetCards;
    store.update('debts', d => { d.credit_payment_overrides = (d.credit_payment_overrides ?? []).filter(o => o.period_id !== id); });
    return false;
  }

  const gen = ev.target.closest('[data-generate-year]');
  if (gen) {
    const rows = generateYear(ctx.state, ctx.cfg, Number(gen.dataset.generateYear), { round: fmt.round });
    if (!rows.length) throw new Error('Все выплаты этого года по графику уже созданы');
    store.update('income', d => { d.periods = [...(d.periods ?? []), ...rows]; });
    ui.year = Number(gen.dataset.generateYear);
    return true;
  }

  // подставить доход выплаты по формуле оклада
  const fill = ev.target.closest('[data-fill-income]');
  if (fill) {
    const id = fill.dataset.fillIncome;
    const net = ctx.income.byId.get(id)?.formula?.net;
    if (net === undefined || net === null) throw new Error('Для этой выплаты нет оклада на дату — считать нечего');
    store.update('income', d => {
      const p = (d.periods ?? []).find(x => x.id === id);
      if (p) p.income_net = net;
    });
    return true;
  }

  if (ev.target.closest('[data-open-add]')) { ui.open.add('add-period'); return true; }
  // закрывают крестик, «Отмена» и клик по затемнению мимо окна
  const close = ev.target.closest('[data-close-add]');
  if (close && (close.tagName === 'BUTTON' || ev.target === close)) { ui.open.delete('add-period'); return true; }

  if (ev.target.closest('[data-add-manual]')) {
    const draft = { ...defaultDraft(ctx), ...(ui.draft.periods ?? {}) };
    const amount = fmt.parseMoney(draft.income_net) ?? 0;
    const [y, m] = String(draft.window).split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    store.update('income', d => {
      (d.periods ?? (d.periods = [])).push({
        id: uid('p'), year: y, slot_order: null, title: 'Разовая выплата',
        pay_date: draft.pay_date,
        window_start: `${draft.window}-01`, window_end: `${draft.window}-${String(last).padStart(2, '0')}`,
        calc_mode: 'manual', income_net: amount, note: draft.note ?? '',
        locked: draft.pay_date < ctx.today,
      });
    });
    ui.draft.periods = defaultDraft(ctx);
    ui.open.delete('add-period');
    ui.year = y;
    return true;
  }
  return false;
}
