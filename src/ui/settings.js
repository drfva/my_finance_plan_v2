/* Настройки: план, порядок распределения, годы и график выплат, оклад, налог,
   история доходов и производственный календарь по годам */

import { esc, card, table, input, select, checkbox, addButton, delButton, button, pill, field, section } from './dom.js';
import { uid } from './edit.js';
import { payoutSchedule } from '../engine/calendar.js';
import { generateYear } from '../engine/income.js';
import { ROLE_TITLES } from './app.js';

export const code = 'settings';
export const title = () => 'Настройки';

/* Эти настройки приложение считает само или они одинаковы для всех — в интерфейсе не нужны */
const HIDDEN_SETTINGS = new Set(['avg_days_in_month', 'extra_currencies']);

/* Какой год предложить добавить: выплат ещё нет — текущий, есть — следующий за последним */
export function nextPlanYear(state, today) {
  const inc = state.income ?? {};
  const known = [...(inc.plan_years ?? []).map(y => Number(y.year)), ...(inc.periods ?? []).map(p => Number(p.year))]
    .filter(Number.isFinite);
  if (!known.length) return Number(today.slice(0, 4));
  return Math.max(...known) + 1;
}

/* Новая выплата в графике: первая — аванс за первую половину, вторая — зарплата за вторую */
function nextSlot(year, slots) {
  const sort_order = (slots.at(-1)?.sort_order ?? 0) + 1;
  const base = { year, sort_order, shift_rule: 'back' };
  if (!slots.length) return { ...base, title: 'Аванс', pay_day: 20, month_offset: 0, window_from_day: 1, window_to_day: 15 };
  if (slots.length === 1) return { ...base, title: 'Зарплата', pay_day: 5, month_offset: 1, window_from_day: 16, window_to_day: 31 };
  return { ...base, title: 'Выплата', pay_day: 10, month_offset: 0, window_from_day: 1, window_to_day: 31 };
}

/* Поле настройки под тип её значения по умолчанию.
   Настройки лежат не строками, а объектом «ключ → значение», поэтому у них свой обработчик. */
function settingField(ctx, s) {
  const { cfg, canEdit } = ctx;
  const disabled = !canEdit;
  if (s.key === 'base_currency' || s.key === 'calendar_code') {
    const options = (s.key === 'base_currency' ? cfg.list('currencies') : cfg.list('calendars'))
      .map(c => ({ value: c.code, label: c.title }));
    return `<select data-setting="${esc(s.key)}"${disabled ? ' disabled' : ''}>${options.map(o =>
      `<option value="${esc(o.value)}"${o.value === s.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  }
  if (typeof s.defaultValue === 'boolean') {
    return `<input type="checkbox" data-setting="${esc(s.key)}" data-kind="boolean"${s.value ? ' checked' : ''}${disabled ? ' disabled' : ''} style="width:auto;min-height:0;">`;
  }
  const kind = typeof s.defaultValue === 'number' ? 'number' : 'text';
  return `<input data-setting="${esc(s.key)}" data-kind="${kind}" value="${esc(s.value)}"${disabled ? ' disabled' : ''} style="max-width:220px;">`;
}

function settingsTable(ctx) {
  const rows = ctx.cfg.all('account').filter(s => !HIDDEN_SETTINGS.has(s.key)).map(s => `<tr>
    <td><b>${esc(s.title || s.key)}</b>${s.description ? `<div class="small-note">${esc(s.description)}</div>` : ''}</td>
    <td>${settingField(ctx, s)}</td>
    <td>${s.isDefault ? pill('по умолчанию') : `${pill('своё', 'ok')} ${button({ action: 'reset-setting', value: s.key, label: 'сбросить', cls: 'ghost small' })}`}</td>
  </tr>`);
  return table({ head: ['Настройка', 'Значение', 'Источник'], rows });
}

function stagesCard(ctx) {
  const { cfg, canEdit } = ctx;
  const stages = cfg.stages();
  const rows = stages.map((s, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td><b>${esc(s.title)}</b><div class="small-note">${esc(s.description)}</div></td>
    <td>${canEdit ? `<div class="priority-controls row" style="gap:4px;">
      ${button({ action: 'stage-move', value: `${s.code}:up`, label: '↑', cls: 'ghost small', disabled: i === 0 })}
      ${button({ action: 'stage-move', value: `${s.code}:down`, label: '↓', cls: 'ghost small', disabled: i === stages.length - 1 })}
    </div>` : ''}</td>
  </tr>`);
  return section({
    key: 'set:stages', open: ctx.ui.open.has('set:stages'),
    title: 'Порядок распределения выплаты',
    note: 'Деньги выплаты расходятся по этапам сверху вниз, что осталось — свободный остаток. '
      + 'Порядок меняется стрелками: расчёт будущих выплат обновится сразу, зафиксированные прошедшие останутся как есть.',
    body: table({ head: [{ title: '№', cls: 'num' }, 'Этап', 'Порядок'], rows }),
  });
}

function yearsCard(ctx) {
  const { state, fmt, canEdit, cfg } = ctx;
  const inc = state.income ?? {};
  const shifts = [{ value: 'back', label: 'раньше' }, { value: 'forward', label: 'позже' }, { value: 'none', label: 'не сдвигать' }];

  const blocks = (inc.plan_years ?? []).slice().sort((a, b) => a.year - b.year).map(y => {
    const year = Number(y.year);
    const slots = (inc.payout_slots ?? []).filter(s => Number(s.year) === year).sort((a, b) => a.sort_order - b.sort_order);
    const count = (inc.periods ?? []).filter(p => Number(p.year) === year).length;
    const slotRows = slots.map(s => `<div class="item-row" style="grid-template-columns:1.2fr .8fr .8fr .8fr .8fr 1fr auto;align-items:end;">
      ${field('Название', input({ edit: 'income|payout_slots|title', key: { year, sort_order: s.sort_order }, value: s.title, disabled: !canEdit }))}
      ${field('Число выплаты', input({ edit: 'income|payout_slots|pay_day', key: { year, sort_order: s.sort_order }, value: s.pay_day, type: 'int', disabled: !canEdit }))}
      ${field('Через месяцев', input({ edit: 'income|payout_slots|month_offset', key: { year, sort_order: s.sort_order }, value: s.month_offset, type: 'int', disabled: !canEdit }))}
      ${field('Период с дня', input({ edit: 'income|payout_slots|window_from_day', key: { year, sort_order: s.sort_order }, value: s.window_from_day, type: 'int', disabled: !canEdit }))}
      ${field('по день', input({ edit: 'income|payout_slots|window_to_day', key: { year, sort_order: s.sort_order }, value: s.window_to_day, type: 'int', disabled: !canEdit }))}
      ${field('Если выходной', select({ edit: 'income|payout_slots|shift_rule', key: { year, sort_order: s.sort_order }, value: s.shift_rule, options: shifts, disabled: !canEdit }))}
      ${canEdit ? delButton({ domain: 'income', table: 'payout_slots', key: { year, sort_order: s.sort_order } }) : ''}
    </div>`).join('');
    const preview = slots.length ? payoutSchedule(year, slots, ctx.sim.income.calendar).slice(0, 2)
      .map(p => `${fmt.date(p.pay_date)} за ${fmt.date(p.window_start, 'dayMonth')}–${fmt.date(p.window_end, 'dayMonth')}`).join(', ') : '';
    return `<div style="margin-bottom:22px;">
      <div class="row between wrap" style="gap:8px;">
        <b style="font-size:16px;">${esc(year)}</b> ${pill(`${count} выплат в плане`)}
        <div class="row wrap" style="gap:8px;">
          ${canEdit ? addButton({ domain: 'income', table: 'payout_slots', label: '+ выплата в графике', row: nextSlot(year, slots) }) : ''}
          ${canEdit && slots.length && !count ? button({ action: 'generate-year', value: year, label: `Создать выплаты ${year} года`, cls: 'primary small' }) : ''}
          ${canEdit ? delButton({ domain: 'income', table: 'plan_years', key: { year }, label: 'удалить год', cls: 'ghost small',
            confirm: `Удалить ${year} год? Вместе с ним удалятся его график и ${count} выплат со всеми ручными суммами.` }) : ''}
        </div>
      </div>
      ${slotRows || '<div class="small-note">Выплат в графике нет.</div>'}
      ${preview ? `<div class="small-note">Например: ${esc(preview)}</div>` : ''}
    </div>`;
  }).join('');

  return section({
    key: 'set:years', open: ctx.ui.open.has('set:years'),
    title: 'Годы плана и график выплат',
    actions: canEdit ? addButton({ domain: 'income', table: 'plan_years', label: '+ год',
      row: { year: nextPlanYear(ctx.state, ctx.today), calendar_code: cfg.get('calendar_code'), note: '' } }) : '',
    note: 'График — сколько раз в месяц платят, какого числа и за какой отрезок месяца. По нему создаются выплаты года.',
    body: blocks || '<div class="muted">Годов плана нет. Добавьте год и задайте график.</div>',
  });
}

function calendarCard(ctx) {
  const { state, fmt, canEdit, cfg, years } = ctx;
  // свёрнутый раздел не считаем: календарь на все годы плана — самая тяжёлая часть настроек
  if (!ctx.ui.open.has('set:calendar')) {
    return section({ key: 'set:calendar', open: false, title: 'Производственный календарь', body: '' });
  }
  const inc = state.income ?? {};
  const cal = ctx.sim.income.calendar;
  const draft = ctx.ui.draft.settings ?? {};
  const blocks = years.map(year => {
    const days = (inc.account_calendar_days ?? []).filter(d => String(d.date).startsWith(String(year)))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const pills = days.map(d => `<span class="day-pill${d.kind === 'workday' ? ' workday' : ''}">
      ${esc(fmt.date(d.date, 'dayMonth'))}
      ${canEdit ? delButton({ domain: 'income', table: 'account_calendar_days', key: { date: d.date }, label: '✕', cls: 'ghost small' }) : ''}
    </span>`).join('');

    const wd = Array.from({ length: 12 }, (_, i) => {
      const ym = `${year}-${String(i + 1).padStart(2, '0')}`;
      const o = (inc.working_day_overrides ?? []).find(x => x.ym === ym);
      return `<td class="num">${input({ edit: 'income|working_day_overrides|working_days', key: { ym },
        value: o?.working_days ?? '', placeholder: String(cal.calendarWorkingDaysInMonth(year, i + 1)),
        type: 'int', empty: 'null', disabled: !canEdit, style: 'max-width:70px;text-align:right;' })}</td>`;
    }).join('');

    return `<div style="margin-bottom:22px;">
      <div class="row between wrap" style="gap:8px;align-items:end;">
        <b style="font-size:16px;">${esc(year)}</b>
        ${canEdit ? `<div class="row wrap" style="gap:8px;align-items:end;">
          <input type="date" data-draft="day-${esc(year)}" value="${esc(draft[`day-${year}`] || `${year}-01-01`)}" style="max-width:170px;">
          ${button({ action: 'add-day', value: String(year), label: '+ нерабочий день', cls: 'small' })}
          ${days.length ? button({ action: 'clear-days', value: String(year), label: `очистить ${year}`, cls: 'ghost small' }) : ''}
        </div>` : ''}
      </div>
      <div class="row wrap" style="gap:8px;margin-top:10px;">
        ${pills || '<span class="small-note" style="margin:0;">Своих дней нет: работают праздники справочника</span>'}
      </div>
      <div class="small-note" style="margin-top:12px;">Рабочих дней в месяце (пусто — по календарю)</div>
      ${table({ head: Array.from({ length: 12 }, (_, i) => ({ title: fmt.monthName(i + 1).slice(0, 3), cls: 'num' })), rows: [`<tr>${wd}</tr>`] })}
    </div>`;
  }).join('');

  return section({
    key: 'set:calendar', open: ctx.ui.open.has('set:calendar'),
    title: 'Производственный календарь',
    note: `Праздники календаря «${esc(cfg.byCode('calendars', cfg.get('calendar_code'))?.title ?? '')}» уже учтены. `
      + 'Здесь — свои нерабочие дни: выберите дату и добавьте. Ниже можно вручную поправить число рабочих дней в месяце.',
    body: blocks,
  });
}


/* Переключатель планов: показывается, когда доступов больше одного.
   Свой план и планы, куда вас добавили владельцы, приходят из базы вместе с ролью. */
function planSwitch(ctx) {
  const list = ctx.state.accounts ?? [];
  if (list.length < 2) return '';
  const current = ctx.state.account?.id;
  return `<div class="info-box" style="margin-bottom:16px;">
    <div class="row between wrap" style="gap:10px;">
      <div>
        <b>Доступные планы</b>
        <div class="small-note" style="margin-top:2px;">Переключение перечитывает данные: несохранённое сначала уходит в базу.</div>
      </div>
      <div class="row wrap" style="gap:8px;">
        ${list.map(a => (a.id === current
          ? pill(`${a.title} · ${ROLE_TITLES[a.role] ?? a.role}`, 'ok')
          : button({ action: 'open-plan', value: a.id, label: `${a.title} · ${ROLE_TITLES[a.role] ?? a.role}`, cls: 'small' }))).join('')}
      </div>
    </div>
  </div>`;
}

/* Аккаунт: пароль, почта и вход по Face ID / Touch ID */
function securityCard(ctx) {
  const sec = ctx.security;
  const open = ctx.ui.open.has('set:security');
  if (!sec) {
    return section({ key: 'set:security', title: 'Вход и безопасность', open,
      body: '<div class="small-note">Раздел доступен только в приложении, подключённом к базе.</div>' });
  }
  if (open) sec.load();
  const st = sec.state;
  const email = st.user?.email ?? '—';

  let keys;
  if (!sec.supported()) {
    keys = '<div class="small-note">Это устройство или версия библиотеки не поддерживает вход по биометрии.</div>';
  } else if (st.passkeys === null) {
    keys = '<div class="small-note">Загружаем список ключей…</div>';
  } else if (!st.passkeys.length) {
    keys = '<div class="small-note">Ключей пока нет. Добавьте — и на этом устройстве можно будет входить по Face ID или Touch ID.</div>';
  } else {
    keys = st.passkeys.map(k => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line);">
      <span>${esc(k.friendly_name || 'Ключ')}<span class="muted" style="font-size:11px;">
        ${k.created_at ? ' · добавлен ' + esc(ctx.fmt.date(String(k.created_at).slice(0, 10))) : ''}
        ${k.last_used_at ? ' · вход ' + esc(ctx.fmt.date(String(k.last_used_at).slice(0, 10))) : ''}</span></span>
      ${button({ action: 'passkey-del', value: k.id, label: '✕', cls: 'ghost small', title: 'Удалить ключ' })}</div>`).join('');
  }

  return section({
    key: 'set:security', title: 'Вход и безопасность', open,
    body: `
      <div class="small-note" style="margin-top:0;">Вход выполнен как <b>${esc(email)}</b>.</div>
      ${st.msg ? `<div class="small-note" style="color:var(--${st.msg.ok ? 'good' : 'danger'});font-weight:700;">${esc(st.msg.text)}</div>` : ''}

      <h3 style="font-size:15px;margin:18px 0 8px;">Сменить пароль</h3>
      <div class="grid cols-2">
        ${field('Новый пароль', '<input type="password" data-sec="pass1" autocomplete="new-password">')}
        ${field('Ещё раз', '<input type="password" data-sec="pass2" autocomplete="new-password">')}
      </div>
      <div style="margin-top:10px;">${button({ action: 'change-password', label: 'Сохранить пароль', cls: 'primary small' })}</div>

      <h3 style="font-size:15px;margin:18px 0 8px;">Почта</h3>
      <div class="row wrap" style="gap:12px;align-items:start;">
        <div style="flex:1;min-width:200px;">${field('Новый адрес', `<input type="email" data-sec="email" placeholder="${esc(email)}">`)}</div>
        <div>${field(' ', button({ action: 'change-email', label: 'Сменить почту' }))}</div>
      </div>
      <div class="small-note">На новый адрес придёт письмо для подтверждения — пока не перейдёте по ссылке, вход остаётся по старому.</div>

      <h3 style="font-size:15px;margin:18px 0 8px;">Вход по Face ID / Touch ID</h3>
      <div class="small-note" style="margin-top:0;margin-bottom:8px;">Пароль остаётся запасным входом: если устройство потеряется, войти можно будет по нему.</div>
      ${keys}
      ${sec.supported() ? `<div style="margin-top:10px;">${button({ action: 'passkey-add', label: '+ добавить Face ID / Touch ID' })}</div>` : ''}

      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);">
        ${button({ action: 'sign-out-account', label: 'Выйти из аккаунта', cls: 'ghost small' })}</div>`,
  });
}

export function render(ctx) {
  const { state, fmt, canEdit, years } = ctx;
  const inc = state.income ?? {};

  const rateRows = (inc.salary_rates ?? []).slice().sort((a, b) => ((a.effective_from || '') < (b.effective_from || '') ? -1 : 1)).map(r => `<tr>
    <td>${input({ edit: 'income|salary_rates|effective_from', key: { id: r.id }, value: r.effective_from, type: 'date', disabled: !canEdit })}</td>
    <td class="num">${input({ edit: 'income|salary_rates|amount', key: { id: r.id }, value: r.amount, type: 'money', disabled: !canEdit })}</td>
    <td>${checkbox({ edit: 'income|salary_rates|is_gross', key: { id: r.id }, value: r.is_gross !== false, disabled: !canEdit, title: 'Сумма до удержания налога' })}</td>
    <td class="num muted">${esc(fmt.money(ctx.income.monthlyNetOn(r.effective_from || ctx.today)))}</td>
    <td>${input({ edit: 'income|salary_rates|note', key: { id: r.id }, value: r.note, disabled: !canEdit })}</td>
    <td>${canEdit ? delButton({ domain: 'income', table: 'salary_rates', key: { id: r.id } }) : ''}</td></tr>`);

  const scaleBlocks = (inc.tax_scales ?? []).map(s => {
    const br = (inc.tax_brackets ?? []).filter(b => b.scale_id === s.id).sort((a, b) => a.sort_order - b.sort_order);
    const rows = br.map(b => `<div class="item-row" style="grid-template-columns:1fr 1fr auto;align-items:end;">
      ${field('Доход до', input({ edit: 'income|tax_brackets|up_to', key: { scale_id: s.id, sort_order: b.sort_order }, value: b.up_to, type: 'money', empty: 'null', placeholder: 'без границы', disabled: !canEdit }))}
      ${field('Ставка, %', input({ edit: 'income|tax_brackets|rate', key: { scale_id: s.id, sort_order: b.sort_order }, value: b.rate, type: 'number', disabled: !canEdit }))}
      ${canEdit ? delButton({ domain: 'income', table: 'tax_brackets', key: { scale_id: s.id, sort_order: b.sort_order } }) : ''}
    </div>`).join('');
    return `<div style="margin-bottom:16px;">
      <div class="row between wrap" style="gap:8px;align-items:end;">
        <div style="flex:2;min-width:160px;">${field('Название шкалы', input({ edit: 'income|tax_scales|title', key: { id: s.id }, value: s.title, disabled: !canEdit }))}</div>
        ${field('Действует с года', input({ edit: 'income|tax_scales|valid_from_year', key: { id: s.id }, value: s.valid_from_year, type: 'int', disabled: !canEdit }))}
        <label class="small-note" style="display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;">
          ${checkbox({ edit: 'income|tax_scales|cumulative', key: { id: s.id }, value: s.cumulative !== false, disabled: !canEdit })} нарастающим итогом за год</label>
        ${canEdit ? delButton({ domain: 'income', table: 'tax_scales', key: { id: s.id }, confirm: 'Удалить шкалу вместе со ступенями?' }) : ''}
      </div>
      <div class="small-note">Ставка применяется только к части дохода внутри своей ступени. Пустая граница — верхняя ступень.</div>
      ${rows}
      ${canEdit ? addButton({ domain: 'income', table: 'tax_brackets', label: '+ ступень',
        row: { scale_id: s.id, sort_order: (br.at(-1)?.sort_order ?? 0) + 1, up_to: null, rate: 13 } }) : ''}
    </div>`;
  }).join('');

  const histYears = [...new Set([...(inc.income_history ?? []).map(h => Number(h.year)), ...years.map(y => y - 1)])].sort();
  const histRows = histYears.map(y => `<tr><td>${esc(y)}</td>${Array.from({ length: 12 }, (_, i) => {
    const h = (inc.income_history ?? []).find(x => Number(x.year) === y && Number(x.month) === i + 1);
    return `<td class="num">${input({ edit: 'income|income_history|amount', key: { year: y, month: i + 1 }, value: h?.amount ?? '',
      placeholder: fmt.money(ctx.income.monthIncome(y, i + 1)), type: 'money', disabled: !canEdit, style: 'max-width:110px;text-align:right;' })}</td>`;
  }).join('')}</tr>`);

  const fxRows = (state.settings?.fx_rates ?? []).slice().sort((a, b) => (a.rate_date < b.rate_date ? 1 : -1)).slice(0, 12)
    .map(r => `<tr><td>${esc(r.base_code)}/${esc(r.quote_code)}</td><td>${esc(fmt.date(r.rate_date))}</td>
      <td class="num">${esc(r.rate)}</td><td>${esc(r.source)}</td></tr>`);

  const empty = !(inc.payout_slots ?? []).length && !(state.savings?.goals ?? []).some(g => g.kind_code !== 'gifts');

  return `
    ${section({ key: 'set:plan', title: 'План', open: ctx.ui.open.has('set:plan'), body: `
      ${planSwitch(ctx)}
      <div class="grid cols-2">
        ${field('Название плана', `<input data-account-title value="${esc(state.account.title)}"${canEdit ? '' : ' disabled'}>`,
          'Показывается в шапке приложения')}
        ${field('Ваша роль', `<div style="padding-top:8px;">${esc(ROLE_TITLES[state.account.role] ?? state.account.role)}</div>`)}
      </div>
      ${empty && canEdit ? `<div class="row wrap" style="gap:8px;margin-top:12px;">
        ${button({ action: 'sample', value: nextPlanYear(state, ctx.today), label: 'Заполнить пример плана', cls: 'primary small' })}
        <span class="small-note">График 20-го и 5-го, оклад, шкала НДФЛ, категории, копилка, подушка, праздники и кредитка — чтобы посмотреть, как всё считается.</span>
      </div>` : ''}` })}

    ${section({ key: 'set:opts', title: 'Настройки плана', open: ctx.ui.open.has('set:opts'), body: settingsTable(ctx) })}
    ${stagesCard(ctx)}
    ${yearsCard(ctx)}

    ${section({
      key: 'set:salary', open: ctx.ui.open.has('set:salary'),
      title: 'Оклад',
      actions: canEdit ? addButton({ domain: 'income', table: 'salary_rates', label: '+ запись',
        row: { id: uid('rate'), effective_from: `${ctx.year}-01-01`, amount: 0, is_gross: true, note: '' } }) : '',
      note: 'С какой даты действует оклад и сколько он. Отработанный день стоит «оклад ÷ рабочих дней месяца».',
      body: table({ head: ['С даты', { title: 'Оклад', cls: 'num' }, 'До налога', { title: 'На руки в месяц', cls: 'num' }, 'Комментарий', ''],
        rows: rateRows.length ? rateRows : ['<tr><td colspan="6" class="muted">Оклад не задан</td></tr>'] }),
    })}

    ${section({
      key: 'set:tax', open: ctx.ui.open.has('set:tax'),
      title: 'Налог',
      actions: canEdit ? addButton({ domain: 'income', table: 'tax_scales', label: '+ шкала',
        row: { id: uid('scale'), title: 'НДФЛ', valid_from_year: ctx.year, cumulative: true } }) : '',
      body: scaleBlocks || '<div class="muted">Шкал нет — налог не удерживается.</div>',
    })}

    ${section({
      key: 'set:history', open: ctx.ui.open.has('set:history'),
      title: 'История доходов',
      note: 'Доход на руки по месяцам: из него считается средний заработок для отпускных. Пустое поле — берётся из выплат плана.',
      body: table({ head: ['Год', ...Array.from({ length: 12 }, (_, i) => ({ title: fmt.monthName(i + 1).slice(0, 3), cls: 'num' }))], rows: histRows }),
    })}

    ${calendarCard(ctx)}

    ${securityCard(ctx)}
    ${fxRows.length ? section({ key: 'set:fx', open: ctx.ui.open.has('set:fx'), title: 'Курсы валют', note: 'Сколько базовой валюты за единицу другой. Курс тянется раз в день.',
      body: table({ head: ['Пара', 'Дата', { title: 'Курс', cls: 'num' }, 'Источник'], rows: fxRows }) }) : ''}`;
}

export function handle(ev, ctx) {
  const { store, cfg, fmt } = ctx;

  const reset = ev.target.closest('[data-reset-setting]');
  if (reset) { store.setSetting(reset.dataset.resetSetting, null); return false; }

  // открыть другой план: данные перечитываются, вкладка и год сбрасываются
  const openPlan = ev.target.closest('[data-open-plan]');
  if (openPlan) {
    const id = openPlan.dataset.openPlan;
    ctx.ui.year = null;
    ctx.ui.open.clear();
    store.switchAccount(id).catch(e => ctx.notice?.('danger', e.message));
    return false;
  }

  /* Аккаунт: всё асинхронное, экран перерисуется сам, когда придёт ответ */
  const sec = ctx.security;
  const val = name => document.querySelector(`[data-sec="${name}"]`)?.value ?? '';
  if (sec) {
    if (ev.target.closest('[data-change-password]')) { sec.changePassword(val('pass1'), val('pass2')); return false; }
    if (ev.target.closest('[data-change-email]')) { sec.changeEmail(val('email').trim()); return false; }
    if (ev.target.closest('[data-passkey-add]')) { sec.addPasskey('Это устройство'); return false; }
    const del = ev.target.closest('[data-passkey-del]');
    if (del) {
      if (confirm('Удалить этот ключ? Входить по биометрии на этом устройстве больше не получится.')) sec.deletePasskey(del.dataset.passkeyDel);
      return false;
    }
  }
  if (ev.target.closest('[data-sign-out-account]')) {
    if (confirm('Выйти из аккаунта на этом устройстве?')) ctx.onSignOut?.();
    return false;
  }

  const addDay = ev.target.closest('[data-add-day]');
  if (addDay) {
    const year = addDay.dataset.addDay;
    const date = (ctx.ui.draft.settings ?? {})[`day-${year}`] || `${year}-01-01`;
    if (!String(date).startsWith(String(year))) throw new Error(`Дата ${fmt.date(date)} не из ${year} года`);
    if ((ctx.state.income?.account_calendar_days ?? []).some(d => d.date === date)) {
      throw new Error(`${fmt.date(date)} уже в списке`);
    }
    store.update('income', d => {
      (d.account_calendar_days ?? (d.account_calendar_days = [])).push({ date, kind: 'holiday', title: '' });
    });
    return true;
  }

  const clearDays = ev.target.closest('[data-clear-days]');
  if (clearDays) {
    const year = clearDays.dataset.clearDays;
    if (!confirm(`Удалить все свои нерабочие дни ${year} года?`)) return false;
    store.update('income', d => {
      d.account_calendar_days = (d.account_calendar_days ?? []).filter(x => !String(x.date).startsWith(year));
    });
    return true;
  }

  const move = ev.target.closest('[data-stage-move]');
  if (move) {
    const [code_, dir] = move.dataset.stageMove.split(':');
    const stages = cfg.stages();
    const i = stages.findIndex(s => s.code === code_);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= stages.length) return false;
    // порядок пишем заново подряд: так стрелки работают даже при одинаковых приоритетах
    const order = stages.map(s => s.code);
    [order[i], order[j]] = [order[j], order[i]];
    store.update('settings', d => {
      const rules = d.allocation_rules ?? (d.allocation_rules = []);
      order.forEach((stageCode, idx) => {
        const rule = rules.find(r => r.stage_code === stageCode);
        if (rule) rule.priority = idx + 1;
        else rules.push({ stage_code: stageCode, priority: idx + 1, enabled: true, params: {} });
      });
    });
    return true;
  }

  const gen = ev.target.closest('[data-generate-year]');
  if (gen) {
    const year = Number(gen.dataset.generateYear);
    const rows = generateYear(ctx.state, cfg, year, { round: fmt.round });
    if (!rows.length) throw new Error('Все выплаты этого года по графику уже созданы');
    store.update('income', d => { d.periods = [...(d.periods ?? []), ...rows]; });
    ctx.ui.year = year;
    ctx.ui.tab = 'periods';
    return true;
  }

  const sample = ev.target.closest('[data-sample]');
  if (sample) { fillSample(ctx, Number(sample.dataset.sample)); return true; }
  return false;
}

/* Настройки хранятся объектом «ключ → значение», поэтому у них свой обработчик, не data-edit */
export function attachSettings(root, store, getCtx) {
  root.addEventListener('change', ev => {
    const ctx = getCtx();
    const el = ev.target;
    if (el.matches('[data-account-title]')) { store.setAccountTitle(el.value); return; }
    if (el.matches('[data-setting]')) {
      const key = el.dataset.setting;
      let value = el.value;
      if (el.dataset.kind === 'boolean') value = el.checked;
      if (el.dataset.kind === 'number') {
        value = ctx.fmt.parseNumber(el.value);
        if (value === null) { el.value = ctx.cfg.get(key); return; }
      }
      store.setSetting(key, value);
    }
  });
}

/* Пример плана — пока нет мастера настройки (этап 6) */
export function fillSample(ctx, year) {
  const { store } = ctx;
  store.update('income', d => {
    d.plan_years = [{ year, calendar_code: 'ru', note: '' }];
    d.payout_slots = [
      { year, sort_order: 1, title: 'Аванс', pay_day: 20, month_offset: 0, window_from_day: 1, window_to_day: 15, shift_rule: 'back' },
      { year, sort_order: 2, title: 'Зарплата', pay_day: 5, month_offset: 1, window_from_day: 16, window_to_day: 31, shift_rule: 'back' },
    ];
    d.salary_rates = [{ id: uid('rate'), effective_from: `${year}-01-01`, amount: 230000, is_gross: true, note: '' }];
    d.tax_scales = [{ id: 'ndfl', title: 'НДФЛ', valid_from_year: 2025, cumulative: true }];
    d.tax_brackets = [
      { scale_id: 'ndfl', sort_order: 1, up_to: 2400000, rate: 13 },
      { scale_id: 'ndfl', sort_order: 2, up_to: 5000000, rate: 15 },
      { scale_id: 'ndfl', sort_order: 3, up_to: 20000000, rate: 18 },
      { scale_id: 'ndfl', sort_order: 4, up_to: 50000000, rate: 20 },
      { scale_id: 'ndfl', sort_order: 5, up_to: null, rate: 22 },
    ];
    d.vacations = [{ id: uid('vac'), title: 'Отпуск', start_date: `${year}-08-10`, end_date: `${year}-08-17`, pay_amount: 0, pay_manual: false }];
  });
  store.update('expenses', d => {
    d.expense_categories = [
      { id: 'cat-life', title: 'Жизнь', mode: 'fixed_month', monthly_amount: 60000, percent_value: 0, split_mode: 'even', sort_order: 1 },
      { id: 'cat-home', title: 'Дом', mode: 'fixed_month', monthly_amount: 20000, percent_value: 0, split_mode: 'by_days', sort_order: 2 },
      { id: 'cat-joy', title: 'Радости', mode: 'percent_income', monthly_amount: 15000, percent_value: 7, split_mode: 'even', sort_order: 3 },
    ];
  });
  store.update('savings', d => {
    const gifts = (d.goals ?? []).find(g => g.kind_code === 'gifts');
    d.goals = [
      { id: 'goal-trip', title: 'Путешествия', kind_code: 'bucket', currency_code: 'RUB', priority: 1, target_amount: 0, starting_balance: 0, pace_amount: 0, completed: false },
      ...(gifts ? [{ ...gifts, priority: 2 }] : []),
      { id: 'goal-cushion', title: 'Подушка', kind_code: 'reserve', currency_code: 'RUB', priority: 3, target_amount: 300000, starting_balance: 0, pace_amount: 5000, completed: false },
    ];
    d.goal_milestones = [
      { id: 'trip-1', goal_id: 'goal-trip', title: 'Весна', target: 150000, deadline: `${year}-04-01`, source: 'manual', user_edited: false, sort_order: 1 },
      { id: 'trip-2', goal_id: 'goal-trip', title: 'Лето', target: 200000, deadline: `${year}-07-31`, source: 'manual', user_edited: false, sort_order: 2 },
    ];
    d.goal_transactions = [
      { id: 'trip-s1', goal_id: 'goal-trip', date: `${year}-04-05`, amount: 150000, kind: 'spend', title: 'Поездка весной', source: 'manual', user_edited: false },
      { id: 'trip-s2', goal_id: 'goal-trip', date: `${year}-07-20`, amount: 200000, kind: 'spend', title: 'Поездка летом', source: 'manual', user_edited: false },
    ];
  });
  store.update('gifts', d => {
    const goalId = (ctx.state.savings?.goals ?? []).find(g => g.kind_code === 'gifts')?.id ?? 'goal-gifts';
    d.gift_events = [
      { id: 'gift-mom', goal_id: goalId, title: 'ДР мамы', day: 15, month: 3, repeat_kind: 'yearly', sort_order: 1 },
      { id: 'gift-ny', goal_id: goalId, title: 'Новый год', day: 25, month: 12, repeat_kind: 'yearly', sort_order: 2 },
    ];
    d.gift_event_amounts = [
      { event_id: 'gift-mom', year, amount: 10000 },
      { event_id: 'gift-ny', year, amount: 25000 },
    ];
  });
  store.update('debts', d => {
    d.credit_cards = [{ id: 'card-1', title: 'Кредитка', credit_limit: 150000, grace_days: 55, currency_code: 'RUB', sort_order: 1 }];
    d.credit_card_ops = [{ id: 'op-1', card_id: 'card-1', op_date: `${year}-02-10`, amount: 60000, kind: 'spend', title: 'Техника', sort_order: 1 }];
  });
}
