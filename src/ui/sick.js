/* Карточки больничных: данные базы, объяснимая формула и реальные поступления. */
import { esc, card, section, input, select, checkbox, field, pill, button, delButton, addButton, table } from './dom.js';
import { uid } from './edit.js';
import { sickParameters, sickPeriodId } from '../engine/sick.js';

export const code = 'sick';
export const title = () => 'Больничные';
export const render = ctx => renderSick(ctx);
export const handle = (ev, ctx) => handleSick(ev, ctx);

const options = entries => entries.map(([value, label]) => ({ value, label }));
export const earningsHelp = () => `<details class="info-box" style="margin-bottom:16px;">
  <summary><b>Какой заработок указывать для больничного?</b></summary>
  <p>Указывайте начисленные суммы <b>до удержания НДФЛ</b> за каждый календарный год, со всех мест работы, с которых начислялись взносы на временную нетрудоспособность и материнство.</p>
  <p><b>Включать:</b> зарплату и оклад, премии, надбавки и доплаты, оплату сверхурочных и работы в выходные, <b>отпускные</b>, компенсацию за неиспользованный отпуск. Вознаграждение по ГПХ — если оно входило в облагаемую базу соответствующего года.</p>
  <p><b>Не включать:</b> сами больничные (включая первые три дня от работодателя), пособия по беременности и родам и уходу за ребёнком, другие освобождённые от взносов государственные пособия; возмещение документально подтверждённых расходов на командировку и компенсации в пределах освобождений; переводы между своими счетами, личные подарки и займы.</p>
  <p>У материальной помощи, суточных, подарков от работодателя и выходных пособий есть условия и необлагаемые пределы. Не исключайте их целиком автоматически: берите только часть, вошедшую в базу взносов. Сам доход от самозанятости/ИП сюда не прибавляйте.</p>
  <p>Самый надёжный источник — данные СФР или бухгалтерии: попросите <b>«сумму заработка, учитываемого для пособий за год»</b>. Справка о доходах для НДФЛ может содержать выплаты, которые сюда не входят. Полную годовую сумму можно указать без ручного обрезания: предельную базу применит расчёт.</p>
  <p>Это отдельная база от отпускных: <b>отпускные входят в больничный, но сами больничные не входят ни в больничный, ни в средний заработок для отпуска.</b></p>
  <a href="https://sfr.gov.ru/employers/lk_insurer/baza_znanij/eln_vyplaty_oss_1/" target="_blank" rel="noopener noreferrer">Правила СФР</a> ·
  <a href="https://www.nalog.gov.ru/rn77/ip/prem_employ/" target="_blank" rel="noopener noreferrer">База страховых взносов — ФНС</a>
</details>`;

export function renderSick(ctx) {
  const { state, income, fmt, canEdit, ui } = ctx;
  const leaves = [...(state.income?.sick_leaves ?? [])].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  const content = leaves.map(s => {
    const f = income.sickLeaves?.find(x => x.leave.id === s.id);
    const params = f?.params ?? sickParameters(s);
    const key = { id: s.id };
    const control = (column, label, type = 'text', fallback, hint, cls = '') => field(label, input({
      edit: `income|sick_leaves|${column}`, key, value: s[column] ?? fallback, type, empty: 'null',
      disabled: !canEdit, cls,
    }), hint);
    const choice = (column, label, items, fallback) => field(label, select({ edit: `income|sick_leaves|${column}`, key,
      value: s[column] ?? fallback, options: options(items), disabled: !canEdit }));
    const check = (column, label) => `<label class="row" style="gap:8px;">${checkbox({ edit: `income|sick_leaves|${column}`, key, value: s[column], disabled: !canEdit })}${esc(label)}</label>`;
    const advanced = `<details style="margin:16px 0;"><summary>Расчётные годы, ограничения и особые условия</summary>
      <div class="grid cols-3" style="margin-top:12px;">
        ${control('case_start_date', 'Начало страхового случая', 'date', s.start_date, 'Для продолжения — дата начала первого листа.')}
        ${control('prior_case_days', 'Дней этого случая до листа', 'int', 0, 'Продолжение не начинает заново первые 3 или 10 дней.')}
        ${control('excluded_days', 'Исключаемых дней из 730', 'int', 0, 'Только специальные периоды приостановления договора/службы. Обычные отпуска и болезни не вычитайте.')}
        ${control('base_year1', 'Первый расчётный год', 'int', params.year1)}
        ${control('base_year2', 'Второй расчётный год', 'int', params.year2)}
        ${control('mrot', 'МРОТ на начало случая, ₽', 'money', params.mrot)}
        ${control('cap1', 'Предельная база первого года, ₽', 'money', params.cap1)}
        ${control('cap2', 'Предельная база второго года, ₽', 'money', params.cap2)}
        ${control('max_base', 'Сумма предельных баз двух лет перед случаем, ₽', 'money', params.maxBase, 'Предел среднего дневного: эта сумма ÷ 730; не меняется при замене лет.')}
      </div>
      ${check('replacement_confirmed', 'Есть законное основание для замены лет и замена увеличивает пособие')}
      <p class="small-note">Замена лет — по заявлению при отпуске по беременности и родам/уходу за ребёнком в расчётном периоде и других прямо предусмотренных законом основаниях. Для неизвестного года заполните ограничения по официальным данным: параметры прошлого года не подставляются автоматически.</p>
    </details>`;
    const care = ['child', 'family'].includes(s.reason) ? `<div class="grid cols-3">
      ${control('recipient', 'За кем ухаживаете', 'text', '', 'Используйте одинаковое имя в разных листах для общего годового лимита.')}
      ${choice('treatment', 'Лечение', [['outpatient', 'Дома (амбулаторно)'], ['inpatient', 'Стационар']], 'outpatient')}
      ${control('used_days', 'Уже оплачено вне плана за год, дней', 'int', 0, 'Листы из этого плана учитываются автоматически. Для нескольких лет/сложных ограничений используйте подтверждённые суммы.')}
      ${s.reason === 'child' ? control('child_age', 'Возраст ребёнка на начало случая', 'int') + choice('child_category', 'Категория', [
        ['usual', 'Обычный уход'], ['special_list', 'До 7 лет: заболевание из особого перечня'],
        ['disabled', 'Ребёнок с инвалидностью'], ['unlimited', 'ВИЧ: совместное пребывание в стационаре'],
        ['unlimited_any', 'Поствакцинальное осложнение / новообразование'],
      ], 'usual') : ''}
    </div>` : '';
    const payers = ['employer', 'sfr'].map(payer => {
      const title = payer === 'employer' ? 'Работодатель' : 'СФР';
      const gross = payer === 'employer' ? f?.employerGross ?? 0 : f?.sfrGross ?? 0;
      const row = income.byId.get(sickPeriodId(s.id, payer));
      const parts = income.periods.flatMap(r => (r.sickParts ?? []).filter(x => x.leave_id === s.id && x.payer === payer));
      const net = row?.salary ?? parts.reduce((n, x) => n + x.net, 0);
      const tax = row?.tax ?? parts.reduce((n, x) => n + x.tax, 0);
      const own = s[`${payer}_net`] !== null && s[`${payer}_net`] !== undefined;
      return `<div class="card" style="margin:0;">
        <h3>${title}</h3><div class="small-note">Начислено: <b>${esc(fmt.money(gross, 'RUB'))}</b> · в плане НДФЛ: ${esc(fmt.money(tax, 'RUB'))} · на руки: <b>${esc(fmt.money(net, 'RUB'))}</b></div>
        ${control(`${payer}_pay_date`, 'Фактическая дата поступления (необязательно)', 'date', undefined, 'Для справки. В плане больничный включён в выплаты оклада за дни болезни, как отпускные.')}
        ${control(`${payer}_net`, 'Подтверждённая сумма на руки (необязательно)', 'money', undefined, 'Пустое поле — расчёт НДФЛ по шкале; 0 — подтверждённый ноль.', own ? 'own' : '')}
        ${payer === 'sfr' ? control('sfr_prior_tax_base', 'Пособия СФР ранее в году вне плана, до НДФЛ, ₽', 'money', 0, 'СФР — отдельный налоговый агент. Суммы из плана учитываются автоматически.') : ''}
        ${canEdit && own ? button({ action: 'sick-reset-net', value: `${s.id}|${payer}`, label: 'Вернуть расчёт по формуле', cls: 'ghost small' }) : ''}
        ${row?.period.locked ? `<div class="small-note">Выплата закреплена: ${esc(fmt.money(row.salary, 'RUB'))}. Для изменения истории сначала разблокируйте её в Доходах.</div>` : ''}
      </div>`;
    }).join('');
    const notices = [...(f?.errors ?? []), ...(f?.warnings ?? [])];
    if (s.benefit_enabled && f && !f.errors.length) {
      if (income.warnings.some(w => w.code === 'sick_outside_plan' && w.sick_leave_id === s.id)) notices.push('Часть дней болезни не попала в расчётные периоды оклада. Добавьте соответствующие выплаты: эта часть больничного пока не включена в план.');
      if (income.warnings.some(w => w.code === 'sick_locked_period' && w.sick_leave_id === s.id)) notices.push('Часть больничного попала в уже зафиксированную выплату оклада. Её история сохранена; чтобы добавить больничный, сначала разблокируйте эту выплату в Доходах.');
      if (income.warnings.some(w => w.code === 'sick_no_tax_scale' && w.sick_leave_id === s.id)) notices.push('Нет налоговой шкалы: заполните её в Настройках или укажите подтверждённую сумму на руки. До этого поступление равно нулю.');
    }
    const splitRows = income.periods.flatMap(r => (r.sickParts ?? []).filter(x => x.leave_id === s.id).map(x => `<tr>
      <td>${esc(fmt.date(r.period.pay_date))}</td><td>${esc(fmt.date(r.period.window_start))}–${esc(fmt.date(r.period.window_end))}</td>
      <td>${x.payer === 'employer' ? 'Работодатель' : 'СФР'}</td><td class="num">${x.days}</td>
      <td class="num">${esc(fmt.money(x.gross, 'RUB'))}</td><td class="num">${esc(fmt.money(x.net, 'RUB'))}</td>
      <td>${r.period.locked ? 'зафиксировано' : ''}</td></tr>`));
    const distribution = splitRows.length ? `<h3 style="margin-top:16px;">Больничный по выплатам оклада</h3>${table({
      head: ['Выплата', 'Расчётный период', 'Плательщик', 'Дней', 'Начислено', 'На руки', ''], rows: splitRows,
    })}` : '';
    const formula = f && !f.disabled && !f.errors.length && s.reason !== 'manual'
      ? `<div class="info-box" style="margin:12px 0;">В базу: ${esc(fmt.money(f.base, 'RUB'))} ÷ ${f.denominator} дней, с учётом минимума и максимума средний дневной: <b>${esc(fmt.number(f.daily, 2))} ₽</b>.<br>
          По стажу: ${Math.round(f.staffRate * 100)}% (для ребёнка до 8 лет — 100%). Оплачено ${f.paidDays} из ${f.count} календарных дней.<br>
          Начислено всего: <b>${esc(fmt.money(f.employerGross + f.sfrGross, 'RUB'))}</b>.</div>
         <details><summary>Расшифровка по дням</summary><p class="small-note">Дневные суммы показаны с округлением. Итог каждого плательщика округляется до копеек после суммирования.</p>${table({ head: ['Дата', 'Плательщик', '%', 'Начислено, ₽'], rows: f.days.map(d => `<tr><td>${esc(fmt.date(d.date))}</td><td>${d.payer === 'employer' ? 'Работодатель' : 'СФР'}</td><td>${d.paid ? Math.round(d.rate * 100) : 'не оплачивается'}</td><td class="num">${esc(fmt.number(d.amount, 2))} ₽</td></tr>`) })}</details>` : '';
    return section({ key: `sick:${s.id}`, open: ui.open.has(`sick:${s.id}`),
      title: `${s.note || 'Больничный'} · ${fmt.date(s.start_date)}–${fmt.date(s.end_date)}`,
      actions: `${pill(s.benefit_enabled ? f?.errors.length ? 'нужны данные' : 'больничный' : 'только отсутствие', f?.errors.length ? 'warn' : '')}${canEdit ? delButton({ domain: 'income', table: 'sick_leaves', key,
        confirm: 'Удалить больничный? Будущие выплаты оклада пересчитаются, их закреплённые части сохранятся. Отдельные выплаты по прежней схеме удалятся вместе с их отчислениями.' }) : ''}`,
      body: `<div class="grid cols-3">
        ${control('start_date', 'Начало листа', 'date')}${control('end_date', 'Конец листа', 'date')}${control('note', 'Название / комментарий')}
      </div>${check('benefit_enabled', 'Рассчитывать больничный и включать в выплаты оклада')}
      <div class="small-note">При выключенном расчёте даты всё равно исключают рабочие дни из оклада. В зафиксированных выплатах история сохраняется.</div>
      ${s.benefit_enabled ? `<div class="grid cols-3" style="margin-top:12px;">
        ${choice('reason', 'Причина', [['illness', 'Своя болезнь / бытовая травма'], ['child', 'Уход за ребёнком'], ['family', 'Уход за взрослым родственником'], ['manual', 'Особый случай: подтверждённые суммы']], 'illness')}
        ${control('insurance_years', 'Страховой стаж: полных лет', 'int', undefined, 'Общий страховой стаж на начало случая, не только у текущего работодателя.')}
        ${control('insurance_months', 'И ещё полных месяцев стажа', 'int', 0)}
        ${control('earnings1', `Заработок за ${params.year1}, до НДФЛ, ₽`, 'money', undefined, 'Нет заработка — впишите 0. Что включать — в памятке выше.')}
        ${control('earnings2', `Заработок за ${params.year2}, до НДФЛ, ₽`, 'money')}
        ${control('district_coefficient', 'Районный коэффициент', 'number', 1)}
        ${control('employment_fraction', 'Доля ставки', 'number', 1, 'Полная ставка — 1, половина — 0,5. Применяется к минимуму.')}
      </div>${care}${s.reason === 'manual' ? `<div class="grid cols-2">${control('employer_gross', 'Начислено работодателем, ₽', 'money')}${control('sfr_gross', 'Начислено СФР, ₽', 'money')}</div><p class="small-note">Для производственной травмы, профзаболевания, ограничений по инвалидности, нарушения режима, увольнения и других особых случаев внесите суммы из подтверждённого расчёта.</p>` : advanced}
      ${notices.length ? `<div class="info-box" style="margin:12px 0;">${notices.map(t => `<p>${esc(t)}</p>`).join('')}</div>` : ''}
      ${formula}${distribution}<div class="grid cols-2" style="margin-top:16px;">${payers}</div>` : ''}`,
    });
  }).join('');
  return card({ title: 'Больничные',
    actions: canEdit ? addButton({ domain: 'income', table: 'sick_leaves', label: '+ больничный', row: {
      id: uid('sick'), start_date: ctx.today, end_date: ctx.today, note: '', benefit_enabled: true, reason: 'illness',
      insurance_months: 0, district_coefficient: 1, employment_fraction: 1, treatment: 'outpatient',
    } }) : '',
    note: 'Оклад уменьшается за рабочие дни болезни, а больничный за попавшие в расчётный период календарные дни добавляется к той же выплате. Как отпускные, он распределяется по периодам оклада. База, ограничения и расчёт — в рублях. '
      + 'Автоматическая формула — для застрахованного работника по трудовому договору. Для ГПХ, ИП и самозанятости используйте подтверждённые суммы особого случая.',
    body: earningsHelp() + (content || '<div class="muted">Больничных нет.</div>'),
  });
}

export function handleSick(ev, ctx) {
  const el = ev.target.closest('[data-sick-reset-net]');
  if (!el || !ctx.canEdit) return false;
  const [id, payer] = el.dataset.sickResetNet.split('|');
  if (!['employer', 'sfr'].includes(payer)) return false;
  ctx.store.update('income', d => { const s = d.sick_leaves.find(s => s.id === id); if (s) s[`${payer}_net`] = null; });
  return true;
}
