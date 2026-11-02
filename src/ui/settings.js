/* Настройки: план, порядок распределения, годы и график выплат, оклад, налог,
   история доходов и производственный календарь по годам */

import { esc, card, table, input, select, checkbox, addButton, delButton, button, pill, field, section } from './dom.js';
import { uid } from './edit.js';
import { payoutSchedule } from '../engine/calendar.js';
import { generateYear } from '../engine/income.js';
import { addMonths, dayOfWeek, daysInMonth, isValid, pad2 } from '../engine/dates.js';
import { ROLE_TITLES } from './app.js';
import { personalFamilyCard } from './family.js';

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
    <td><b>${esc(s.title)}</b><div class="small-note">${esc({ gifts: 'Суммы к датам праздников', buckets: 'Цели с оборотом, этапами, периодичностью' }[s.code] ?? s.description)}</div></td>
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
    body: table({ head: [{ title: '№', cls: 'num' }, 'Этап', 'Порядок'], rows }) + creditRepayment(ctx),
  });
}

function creditRepayment(ctx) {
  return `<div class="small-note" style="margin-top:20px;">Досрочное погашение использует свободный остаток после всех обычных распределений. Очередь кредиток и рассрочек — как у их этапов выше.</div>`
    + ['credits','installments'].map(code => {
      const stage = ctx.cfg.stages().find(s => s.code === code);
      const enabled = code === 'credits' ? stage?.params?.early_repayment !== false : stage?.params?.early_repayment === true;
      const params = value => JSON.stringify({ ...stage?.params, early_repayment: value });
      return `<div class="credit-repayment"><h3>${code === 'credits' ? 'Как гасим кредитки' : 'Как гасим рассрочки'}</h3>
        ${field('Свободный остаток выплаты', select({ edit: 'settings|allocation_rules|params', key: { stage_code: code }, type: 'json',
          value: params(enabled), options: [
            { value: params(true), label: code === 'credits' ? 'гасить карты досрочно' : 'досрочно уменьшать ближайшие платежи' },
            { value: params(false), label: 'не гасить досрочно' },
          ], disabled: !ctx.canEdit, defaults: { priority: stage?.priority ?? (code === 'credits' ? 4 : 3), enabled: true } }))}
      </div>`;
    }).join('');
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
    const open = ctx.ui.open.has(`set:year:${year}`);
    return `<div class="plan-year" data-section="set:year:${year}">
      <div class="row between wrap" style="gap:8px;">
        <button class="section-head" data-toggle="set:year:${year}" aria-expanded="${open}">
          <span class="chev${open ? ' open' : ''}">▸</span><h3>${esc(year)}</h3></button>
        <span class="small-note">${slots.length} ${fmt.plural(slots.length, { one: 'выплата', few: 'выплаты', many: 'выплат' })} в месяц · ${count} в плане</span>
        <div class="row wrap" style="gap:8px;">
          ${canEdit ? addButton({ domain: 'income', table: 'payout_slots', label: '+ выплата в графике', row: nextSlot(year, slots) }) : ''}
          ${canEdit && slots.length && !count ? button({ action: 'generate-year', value: year, label: `Создать выплаты ${year} года`, cls: 'primary small' }) : ''}
          ${canEdit ? delButton({ domain: 'income', table: 'plan_years', key: { year }, label: 'удалить год', cls: 'ghost small',
            confirm: `Удалить ${year} год? Вместе с ним удалятся его график и ${count} выплат со всеми ручными суммами.` }) : ''}
        </div>
      </div>
      ${open ? `<div style="margin-top:16px;">${slotRows || '<div class="small-note">Выплат в графике нет.</div>'}
        ${preview ? `<div class="small-note">Например: ${esc(preview)}</div>` : ''}</div>` : ''}
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

export function calendarCard(ctx) {
  const { state, fmt, canEdit, cfg } = ctx;
  // свёрнутый раздел не считаем: календарь на все годы плана — самая тяжёлая часть настроек
  if (!ctx.ui.open.has('set:calendar')) {
    return section({ key: 'set:calendar', open: false, title: 'Производственный календарь', body: '' });
  }
  const inc = state.income ?? {};
  const cal = ctx.sim.income.calendar;
  const draft = ctx.ui.draft.settings ?? {};
  const ym = /^\d{4}-\d{2}$/.test(draft.calendarMonth ?? '') && isValid(`${draft.calendarMonth}-01`)
    ? draft.calendarMonth : `${ctx.year || ctx.today.slice(0, 4)}-${ctx.today.slice(5, 7)}`;
  const [year, month] = ym.split('-').map(Number);
  const count = daysInMonth(year, month);
  const selected = draft.calendarDay?.startsWith(ym) && isValid(draft.calendarDay) ? draft.calendarDay : `${ym}-01`;
  const selectedInfo = cal.day(selected);
  const own = (inc.account_calendar_days ?? []).find(d => d.date === selected);
  const working = cal.calendarWorkingDaysInMonth(year, month);
  const holidays = Array.from({ length: count }, (_, i) => cal.day(`${ym}-${pad2(i + 1)}`)).filter(d => d.holiday).length;
  const cells = Array.from({ length: (dayOfWeek(`${ym}-01`) + 6) % 7 }, () => '<span aria-hidden="true"></span>');
  for (let n = 1; n <= count; n++) {
    const date = `${ym}-${pad2(n)}`;
    const info = cal.day(date);
    const label = info.working ? 'рабочий' : info.holiday ? 'праздник' : 'выходной';
    cells.push(`<button class="calendar-day ${info.working ? 'working' : info.holiday ? 'holiday' : 'weekend'}${date === ctx.today ? ' today' : ''}"
      data-calendar-day="${date}" aria-pressed="${date === selected}" aria-label="${esc(fmt.date(date))}: ${label}${info.title ? ', ' + esc(info.title) : ''}${info.source === 'account' ? ', свой день' : ''}"
      title="${esc(info.title || label)}"><span>${n}</span>${info.source === 'account' ? '<i aria-hidden="true">•</i>' : ''}</button>`);
  }
  const pickerYear = Number(draft.calendarPickerYear) || year;
  const pickerOpen = ctx.ui.open.has('calendar-picker');
  const blocks = `<div class="production-calendar">
    <div class="row between calendar-nav">
      ${button({ action: 'calendar-month', value: `${ym}:-1`, label: '‹', title: 'Предыдущий месяц', cls: 'ghost' })}
      <button class="ghost calendar-month-title" data-toggle="calendar-picker" aria-expanded="${pickerOpen}" aria-controls="calendar-month-picker"
        title="Выбрать месяц и год">${esc(fmt.monthName(month))} ${year}</button>
      ${pickerOpen ? `<div class="calendar-month-picker" id="calendar-month-picker" role="group" aria-label="Выбор месяца и года">
        <div class="row between">
          ${button({ action: 'calendar-picker-year', value: `${pickerYear}:-1`, label: '‹', title: 'Предыдущий год', cls: 'ghost small', disabled: pickerYear <= 1 })}
          <select data-calendar-picker="year" aria-label="Год календаря">${[...new Set([...(ctx.years ?? []), ...Array.from({ length: 11 }, (_, i) => pickerYear + i - 5)])]
            .filter(y => y > 0 && y <= 9999).sort((a,b) => a-b).map(y => `<option value="${y}"${pickerYear === y ? ' selected' : ''}>${y}</option>`).join('')}</select>
          ${button({ action: 'calendar-picker-year', value: `${pickerYear}:1`, label: '›', title: 'Следующий год', cls: 'ghost small', disabled: pickerYear >= 9999 })}
        </div>
        <div class="calendar-month-grid">${Array.from({ length: 12 }, (_, i) => `<button class="small" data-calendar-jump="${pickerYear}-${pad2(i + 1)}"
          aria-pressed="${pickerYear === year && i + 1 === month}">${esc(fmt.monthName(i + 1))}</button>`).join('')}</div>
      </div>` : ''}
      ${button({ action: 'calendar-month', value: `${ym}:1`, label: '›', title: 'Следующий месяц', cls: 'ghost' })}
    </div>
    <div class="calendar-week">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<span>${d}</span>`).join('')}</div>
    <div class="calendar-grid">${cells.join('')}</div>
    <div class="calendar-legend row wrap"><span class="working">Рабочий</span><span class="weekend">Выходной</span><span class="holiday">Праздник</span><span>• свой день</span></div>
    <div class="row wrap calendar-counts">${pill(`Рабочих: ${working}`, 'ok')}${pill(`Нерабочих: ${count - working}`)}${pill(`Праздников: ${holidays}`)}</div>
    <div class="info-box calendar-selection">
      <div><b>${esc(fmt.date(selected))} — ${selectedInfo.working ? 'рабочий день' : selectedInfo.holiday ? 'праздник / нерабочий день' : 'выходной'}</b>
      ${selectedInfo.title ? `<div>${esc(selectedInfo.title)}</div>` : ''}</div>
      ${canEdit ? `<div class="row wrap calendar-day-actions">
        ${button({ action: 'calendar-set', value: `${selected}:${selectedInfo.working ? 'holiday' : 'workday'}`,
          label: selectedInfo.working ? 'Сделать нерабочим' : 'Сделать рабочим', cls: 'ghost small' })}
        ${own ? button({ action: 'calendar-set', value: `${selected}:default`, label: 'По календарю', cls: 'ghost small' }) : ''}
      </div>` : ''}
    </div>
  </div>`;

  return section({
    key: 'set:calendar', open: ctx.ui.open.has('set:calendar'),
    title: 'Производственный календарь',
    note: `Праздники календаря «${esc(cfg.byCode('calendars', cfg.get('calendar_code'))?.title ?? '')}» уже учтены. `
      + 'Листайте месяцы и выбирайте день, чтобы изменить его тип. Изменения учитываются в автоматическом доходе.',
    body: blocks,
  });
}


/* Переключатель планов: показывается, когда доступов больше одного.
   Свой план и планы, куда вас добавили владельцы, приходят из базы вместе с ролью. */
export function planSwitch(ctx) {
  const list = ctx.state.accounts ?? [];
  if (!list.length) return '';
  const current = ctx.state.account?.id;
  return `<div class="info-box plan-switch" style="margin-top:16px;">
      <div>
        <b>Доступные планы</b>
      </div>
      <div class="row wrap plan-choices" style="gap:8px;margin-top:10px;">
        ${list.map(a => (a.id === current
          ? `<span class="plan-choice current" aria-current="true">${esc(a.title)} · ${esc(ROLE_TITLES[a.role] ?? a.role)}</span>`
          : button({ action: 'open-plan', value: a.id, label: `${a.title} · ${ROLE_TITLES[a.role] ?? a.role}`, cls: 'small plan-choice available' }))).join('')}
      </div>
  </div>`;
}

/* Аккаунт: пароль, почта и вход по Face ID / Touch ID */
export function accountDeletionDialog(ctx) {
  const sec=ctx.security,d=sec?.state.deletion;
  if(!d)return '';
  const preview=d.preview,blocked=preview?.plans.filter(p=>p.blocked)??[],removed=preview?.plans.filter(p=>p.delete)??[];
  const busy=sec.state.deleting,canDelete=preview&&!blocked.length&&!d.loading&&!busy;
  return `<div class="modal-back"><div class="modal card account-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
    <div class="card-title"><h2 id="delete-account-title">Удалить аккаунт</h2><button class="ghost small" data-account-delete-cancel aria-label="Отменить удаление"${busy?' disabled':''}>✕</button></div>
    ${d.loading?'<p role="status">Проверяем ваши планы…</p>':preview?`
      <p>Учётная запись и данные личных планов без других участников будут удалены без возможности восстановления.</p>
      ${removed.length?`<p>Будут удалены планы:</p><ul>${removed.map(p=>`<li>${esc(p.title)}</li>`).join('')}</ul>`:'<p>Личных планов без других участников нет.</p>'}
      <p>Общие планы останутся у остальных участников. Ваш доступ к ним прекратится. Семейные взносы и общая история сохранятся с обезличенным профилем.</p>
      ${preview.family?`<p class="${preview.family.last_member?'danger-text':''}">${preview.family.last_member
        ?`Вы последний участник семьи «${esc(preview.family.title)}»: семейный план тоже будет удалён.`
        :`Вы выйдете из семьи «${esc(preview.family.title)}». Будущие взносы и добор недостачи прекратятся.`}</p>`:''}
      ${blocked.length?`<div class="info-box"><b>Сначала назначьте другого владельца общих планов.</b>
        ${blocked.map(p=>`<div style="margin-top:16px;"><b>${esc(p.title)}</b><div class="row wrap" style="gap:10px;margin-top:8px;">
          <select data-deletion-owner="${esc(p.id)}" aria-label="Новый владелец ${esc(p.title)}"${busy?' disabled':''} style="max-width:320px;">
            <option value="">Выберите участника</option>${p.recipients.map(m=>`<option value="${esc(m.id)}">${esc(m.email)}</option>`).join('')}</select>
          ${button({action:'account-assign-owner',value:p.id,label:'Назначить владельцем',disabled:busy,cls:'small'})}</div></div>`).join('')}</div>`:
        field('Для подтверждения введите УДАЛИТЬ',`<input data-account-delete-word aria-label="Подтверждение удаления аккаунта" autocomplete="off" spellcheck="false" value="${esc(d.confirmation)}"${busy?' disabled':''}>`)}
    `:''}
    ${d.error?`<p class="danger-text" role="alert">${esc(d.error)}</p>`:''}
    <div class="row wrap" style="gap:10px;margin-top:22px;">
      ${button({action:'account-delete-cancel',label:'Отмена',disabled:busy,cls:'small'})}
      ${!blocked.length&&(canDelete||busy)?button({action:'account-delete-confirm',label:busy?'Удаляем…':'Удалить аккаунт навсегда',disabled:busy||String(d.confirmation).trim().toUpperCase()!=='УДАЛИТЬ',cls:'danger small'}):''}
    </div></div></div>`;
}

export function securityCard(ctx) {
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
  } else if (!sec.hasList()) {
    keys = '<div class="small-note">Список ключей эта версия библиотеки не отдаёт — добавить ключ можно, '
      + 'а посмотреть и удалить их получится в панели Supabase.</div>';
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
      <div class="field"><label>Новый адрес</label><div class="security-email">
        <input type="email" data-sec="email" placeholder="${esc(email)}">
        ${button({ action: 'change-email', label: 'Сменить почту' })}
      </div></div>
      <div class="small-note">На новый адрес придёт письмо для подтверждения — пока не перейдёте по ссылке, вход остаётся по старому.</div>

      <h3 style="font-size:15px;margin:18px 0 8px;">Вход по Face ID / Touch ID</h3>
      <div class="small-note" style="margin-top:0;margin-bottom:8px;">Пароль остаётся запасным входом: если устройство потеряется, войти можно будет по нему.</div>
      ${keys}
      ${sec.supported() && sec.canAdd() ? `<div style="margin-top:10px;">${button({ action: 'passkey-add', label: '+ добавить Face ID / Touch ID' })}</div>` : ''}

      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);">
        ${button({ action: 'sign-out-account', label: 'Выйти из аккаунта', cls: 'ghost small' })}
        ${button({action:'account-delete-open',label:'Удалить аккаунт',cls:'danger small'})}</div>`,
  })+accountDeletionDialog(ctx);
}

export function render(ctx) {
  const { state, fmt, canEdit, years } = ctx;
  const inc = state.income ?? {};

  const rateRows = (inc.salary_rates ?? []).slice().sort((a, b) => ((a.effective_from || '') < (b.effective_from || '') ? -1 : 1)).map(r => `<tr>
    <td>${input({ edit: 'income|salary_rates|effective_from', key: { id: r.id }, value: r.effective_from, type: 'date', disabled: !canEdit })}</td>
    <td class="num">${input({ edit: 'income|salary_rates|amount', key: { id: r.id }, value: r.amount, type: 'money', disabled: !canEdit })}</td>
    <td>${checkbox({ edit: 'income|salary_rates|is_gross', key: { id: r.id }, value: r.is_gross !== false, disabled: !canEdit, title: 'Сумма до удержания налога' })}</td>
    <td>${checkbox({ edit: 'income|salary_rates|indexed', key: { id: r.id }, value: r.indexed === true, disabled: !canEdit,
      title: 'Оклады подняли всем: заработок до этой даты индексируется при расчёте отпускных' })}</td>
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
      placeholder: fmt.money(ctx.income.monthGross(y, i + 1)), type: 'money', disabled: !canEdit, style: 'max-width:110px;text-align:right;' })}</td>`;
  }).join('')}</tr>`);

  const fxRows = (state.settings?.fx_rates ?? []).slice().sort((a, b) => (a.rate_date < b.rate_date ? 1 : -1)).slice(0, 12)
    .map(r => `<tr><td>${esc(r.base_code)}/${esc(r.quote_code)}</td><td>${esc(fmt.date(r.rate_date))}</td>
      <td class="num">${esc(r.rate)}</td><td>${esc(r.source)}</td></tr>`);

  return `
    ${section({ key: 'set:plan', title: 'План', open: ctx.ui.open.has('set:plan'), body: `
      <div class="grid cols-2">
        ${field('Название плана', `<input data-account-title value="${esc(state.account.title)}"${canEdit ? '' : ' disabled'}>`)}
        ${field('Ваша роль', `<div style="padding-top:8px;">${esc(ROLE_TITLES[state.account.role] ?? state.account.role)}</div>`)}
      </div>
      ${planSwitch(ctx)}` })}

    ${section({ key: 'set:opts', title: 'Настройки плана', open: ctx.ui.open.has('set:opts'), body: settingsTable(ctx) })}
    ${personalFamilyCard(ctx)}
    ${stagesCard(ctx)}
    ${yearsCard(ctx)}

    ${section({
      key: 'set:salary', open: ctx.ui.open.has('set:salary'),
      title: 'Оклад',
      actions: canEdit ? addButton({ domain: 'income', table: 'salary_rates', label: '+ запись',
        row: { id: uid('rate'), effective_from: `${ctx.year}-01-01`, amount: 0, is_gross: true, note: '' } }) : '',
      note: 'С какой даты действует оклад и сколько он. Отработанный день стоит «оклад ÷ рабочих дней месяца». '
        + 'Галочка «Всем» — повышение коснулось всех работников: тогда при расчёте отпускных заработок до этой даты индексируется (п. 16 Положения № 922).',
      body: table({ head: ['С даты', { title: 'Оклад', cls: 'num' }, 'До налога', 'Всем', { title: 'На руки в месяц', cls: 'num' }, 'Комментарий', ''],
        rows: rateRows.length ? rateRows : ['<tr><td colspan="7" class="muted">Оклад не задан</td></tr>'] }),
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
      note: 'Начисленный доход по месяцам — оклад и премии до налога. Из него считается средний заработок для отпускных. '
        + 'Пустое поле — месяц берётся из выплат плана (они пересчитываются в начисленные по шкале налога).',
      body: table({ head: ['Год', ...Array.from({ length: 12 }, (_, i) => ({ title: fmt.monthName(i + 1).slice(0, 3), cls: 'num' }))], rows: histRows }),
    })}

    ${calendarCard(ctx)}

    ${securityCard(ctx)}
    ${fxRows.length ? section({ key: 'set:fx', open: ctx.ui.open.has('set:fx'), title: 'Курсы валют', note: 'Сколько базовой валюты за единицу другой. Курс тянется раз в день.',
      body: table({ head: ['Пара', 'Дата', { title: 'Курс', cls: 'num' }, 'Источник'], rows: fxRows }) }) : ''}`;
}

export function handle(ev, ctx) {
  const { store, cfg, fmt } = ctx;

  const pickerYear = ev.target.closest('[data-calendar-picker-year]');
  if (pickerYear) {
    const [year, step] = pickerYear.dataset.calendarPickerYear.split(':').map(Number);
    if (![-1,1].includes(step) || year + step < 1 || year + step > 9999) return false;
    (ctx.ui.draft.settings ??= {}).calendarPickerYear = year + step;
    return true;
  }
  const jump = ev.target.closest('[data-calendar-jump]');
  if (jump) {
    if (!isValid(`${jump.dataset.calendarJump}-01`)) return false;
    (ctx.ui.draft.settings ??= {}).calendarMonth = jump.dataset.calendarJump;
    ctx.ui.open.delete('calendar-picker');
    return true;
  }

  const month = ev.target.closest('[data-calendar-month]');
  if (month) {
    const [ym, step] = month.dataset.calendarMonth.split(':');
    if (!isValid(`${ym}-01`) || ![-1, 1].includes(Number(step))) return false;
    const [y, m] = ym.split('-').map(Number);
    const next = addMonths(y, m, Number(step));
    (ctx.ui.draft.settings ??= {}).calendarMonth = `${next.y}-${pad2(next.m)}`;
    delete ctx.ui.draft.settings.calendarPickerYear;
    ctx.ui.open.delete('calendar-picker');
    return true;
  }
  const day = ev.target.closest('[data-calendar-day]');
  if (day) {
    if (!isValid(day.dataset.calendarDay)) return false;
    ctx.ui.open.delete('calendar-picker');
    (ctx.ui.draft.settings ??= {}).calendarDay = day.dataset.calendarDay;
    return true;
  }
  const setDay = ev.target.closest('[data-calendar-set]');
  if (setDay) {
    if (!ctx.canEdit) return false;
    const [date, kind] = setDay.dataset.calendarSet.split(':');
    if (!isValid(date) || !['workday', 'holiday', 'default'].includes(kind)) return false;
    store.update('income', d => {
      const days = d.account_calendar_days ??= [];
      const own = days.find(x => x.date === date);
      if (kind === 'default') d.account_calendar_days = days.filter(x => x.date !== date);
      else if (own) own.kind = kind;
      else days.push({ date, kind, title: '' });
    });
    return true;
  }

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
    if(ev.target.closest('[data-account-delete-open]')){sec.prepareDeletion();return false;}
    if(ev.target.closest('[data-account-delete-cancel]')){sec.closeDeletion();return false;}
    if(ev.target.closest('[data-account-delete-confirm]')){
      (async()=>{
        await store.flush();
        if(store.hasPending())throw new Error('Сначала дождитесь сохранения изменений');
        if(await sec.deleteAccount(sec.state.deletion?.confirmation??''))location.replace(location.origin+location.pathname);
      })().catch(e=>{if(sec.state.deletion){sec.state.deletion.error=e.message;ctx.notice?.('danger',e.message);}});
      return false;
    }
    const transfer=ev.target.closest('[data-account-assign-owner]');
    if(transfer){
      const account=transfer.dataset.accountAssignOwner;
      const select=document.querySelector(`[data-deletion-owner="${account}"]`);
      if(!select?.value)return false;
      if(confirm(`Назначить ${select.selectedOptions[0].textContent} владельцем общего плана? Этот участник получит полный доступ к управлению планом.`))sec.assignOwner(account,select.value);
      return false;
    }
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

  return false;
}

/* Настройки хранятся объектом «ключ → значение», поэтому у них свой обработчик, не data-edit */
export function attachSettings(root, store, getCtx, render = () => {}) {
  root.addEventListener('input',ev=>{
    if(!ev.target.matches('[data-account-delete-word]'))return;
    const sec=getCtx().security,d=sec?.state.deletion;if(!d)return;
    d.confirmation=ev.target.value;
    const button=root.querySelector('[data-account-delete-confirm]');
    if(button)button.disabled=sec.state.deleting||d.confirmation.trim().toUpperCase()!=='УДАЛИТЬ';
  });
  root.addEventListener('keydown',ev=>{
    if (ev.key === 'Escape' && getCtx().ui.open.has('calendar-picker')) {
      getCtx().ui.open.delete('calendar-picker'); render(); ev.preventDefault(); return;
    }
    const modal=root.querySelector('.account-delete-dialog');if(!modal)return;
    if(ev.key==='Escape'){getCtx().security?.closeDeletion();ev.preventDefault();return;}
    if(ev.key!=='Tab')return;
    const focusable=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
    const first=focusable[0],last=focusable.at(-1);
    if(!first||!modal.contains(document.activeElement)){first?.focus();ev.preventDefault();}
    else if(ev.shiftKey&&document.activeElement===first){last?.focus();ev.preventDefault();}
    else if(!ev.shiftKey&&document.activeElement===last){first?.focus();ev.preventDefault();}
  });
  root.addEventListener('change', ev => {
    const ctx = getCtx();
    const el = ev.target;
    if (el.matches('[data-calendar-picker]')) {
      const value = Number(el.value);
      if (!Number.isInteger(value) || value < 1 || value > 9999) return;
      (ctx.ui.draft.settings ??= {}).calendarPickerYear = value;
      render();
      root.querySelector('[data-calendar-picker="year"]')?.focus?.({ preventScroll: true });
      return;
    }
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
