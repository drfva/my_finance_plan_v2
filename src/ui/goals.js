/* Копилки: цели с этапами, движениями, переводами и повторяющимися накоплениями */

import { esc, card, table, input, select, checkbox, addButton, delButton, button, pill, field } from './dom.js';
import { uid } from './edit.js';
import { goalBalanceAt, goalProgressAt, proposeRedistribution, forecastBeyondPlan } from '../engine/allocation.js';
import { goalTotal, cycleDates } from '../engine/savings.js';

export const code = 'goals';
export const title = () => 'Копилки';

const KIND_TITLES = { bucket: 'копилка', reserve: 'подушка', gifts: 'подарки' };
const isTransfer = t => t.kind === 'transfer_in' || t.kind === 'transfer_out';

/* Приоритет меняется стрелками: цели этого же типа нумеруются заново */
export function moveGoal(ctx, id, dir) {
  const { store, state } = ctx;
  const goal = (state.savings?.goals ?? []).find(g => g.id === id);
  if (!goal) return false;
  const list = (state.savings?.goals ?? []).filter(g => g.kind_code === goal.kind_code)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const i = list.findIndex(g => g.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return false;
  const order = list.map(g => g.id);
  [order[i], order[j]] = [order[j], order[i]];
  store.update('savings', d => {
    order.forEach((gid, idx) => {
      const g = d.goals.find(x => x.id === gid);
      if (g) g.priority = idx + 1;
    });
  });
  return true;
}

function transferForm(ctx, goal) {
  const { state, ui, canEdit } = ctx;
  if (!canEdit) return '';
  const draft = ui.draft.transfer?.goal_id === goal.id ? ui.draft.transfer : null;
  if (!draft) return '';
  const targets = (state.savings?.goals ?? []).filter(g => g.id !== goal.id)
    .map(g => ({ value: g.id, label: `${g.title} · ${KIND_TITLES[g.kind_code] ?? g.kind_code}` }));
  if (!targets.length) return '<div class="small-note">Других целей нет — переводить некуда.</div>';
  return `<div class="info-box" style="margin-top:10px;">
    <div class="row wrap" style="gap:12px;align-items:end;">
      ${field('Куда перевести', `<select data-draft="to">${targets.map(t =>
        `<option value="${esc(t.value)}"${t.value === draft.to ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`)}
      ${field('Сумма', `<input class="num" inputmode="decimal" data-draft="amount" value="${esc(draft.amount ?? '')}">`)}
      ${field('Дата', `<input type="date" data-draft="date" value="${esc(draft.date)}">`)}
      ${field('Название', `<input data-draft="title" value="${esc(draft.title ?? '')}" placeholder="Перевод">`)}
      ${button({ action: 'transfer-apply', value: goal.id, label: 'Перевести', cls: 'primary small' })}
      ${button({ action: 'transfer-cancel', value: goal.id, label: 'Отмена', cls: 'ghost small' })}
    </div>
    <div class="small-note">Появятся два движения: списание здесь и пополнение там. Они связаны: поправите одно — изменится и второе.</div>
  </div>`;
}

function cyclesBlock(ctx, goal) {
  const { state, fmt, canEdit, cfg } = ctx;
  const cycles = (state.savings?.goal_cycles ?? []).filter(c => c.goal_id === goal.id);
  const units = cfg.list('period_units').map(u => ({ value: u.code, label: u.title }));
  const planEnd = ctx.sim.planEnd || `${ctx.year}-12-31`;

  const rows = cycles.map(c => {
    const dates = cycleDates(c, planEnd, cfg.list('period_units'));
    return `<div class="card cycle-card">
      <div class="row wrap" style="gap:12px;align-items:start;">
        ${field('Название', input({ edit: 'savings|goal_cycles|title', key: { id: c.id }, value: c.title, disabled: !canEdit }))}
        ${field('Сумма к дате', input({ edit: 'savings|goal_cycles|amount', key: { id: c.id }, value: c.amount, type: 'money', disabled: !canEdit }))}
        ${field('Первый раз', input({ edit: 'savings|goal_cycles|start_date', key: { id: c.id }, value: c.start_date, type: 'date', disabled: !canEdit }))}
        ${field('Повторять каждые', input({ edit: 'savings|goal_cycles|every_n', key: { id: c.id }, value: c.every_n, type: 'int', disabled: !canEdit, style: 'max-width:90px;' }))}
        ${field(' ', select({ edit: 'savings|goal_cycles|period_unit', key: { id: c.id }, value: c.period_unit, options: units, disabled: !canEdit }))}
        ${field('Сколько раз', input({ edit: 'savings|goal_cycles|repeats', key: { id: c.id }, value: c.repeats, type: 'int', empty: 'null', placeholder: 'без конца', disabled: !canEdit, style: 'max-width:110px;' }))}
        ${canEdit ? delButton({ domain: 'savings', table: 'goal_cycles', key: { id: c.id }, confirm: 'Удалить повторяющееся накопление вместе с созданными этапами и тратами?' }) : ''}
      </div>
      <div class="row wrap" style="gap:14px;margin-top:12px;">
        <label class="small-note" style="display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;margin:0;">
          ${checkbox({ edit: 'savings|goal_cycles|auto_spend', key: { id: c.id }, value: c.auto_spend !== false, disabled: !canEdit })}
          тратить накопленное в ту же дату</label>
        <label class="small-note" style="display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;margin:0;">
          ${checkbox({ edit: 'savings|goal_cycles|enabled', key: { id: c.id }, value: c.enabled !== false, disabled: !canEdit })}
          включено</label>
      </div>
      <div class="small-note" style="margin-top:10px;">
        ${dates.length ? `Создаёт этапы: ${dates.slice(0, 4).map(d => esc(fmt.date(d))).join(', ')}${dates.length > 4 ? ' …' : ''}`
          : 'Пока ничего не создаёт: дата начала за пределами плана.'}
      </div>
    </div>`;
  }).join('');

  return `<div>
    <div class="small-note" style="margin-top:0;">Повторяющееся накопление: копим сумму к дате, тратим и копим снова.
      Этапы и траты на все годы плана появятся сами; поправленный руками этап шаблон больше не трогает.</div>
    ${rows || '<div class="small-note">Пока ничего не повторяется. Нажмите ⟳ у этапа выше — или, если этапов нет, «Сделать периодической» у самой копилки.</div>'}
  </div>`;
}

/* Успеваем ли к сроку этапа: подпись и цвет для метки */
export function milestoneStatus(ctx, goal, m) {
  const { fmt, sim } = ctx;
  const list = sim.milestonesOf(goal);
  const i = list.findIndex(x => x.id === m.id);
  const done = (sim.milestoneDates[goal.id] ?? [])[i];
  if (done) {
    const label = done === 'pre' ? 'уже накоплено'
      : m.deadline ? (done <= m.deadline ? `в графике (к ${fmt.date(done)})` : `позже срока (к ${fmt.date(done)})`)
      : `прогноз: к ${fmt.date(done)}`;
    const cls = (!m.deadline || done === 'pre' || done <= m.deadline) ? 'ok' : 'warn';
    return { label, cls, done };
  }
  // внутри плана этап не закрывается — продлеваем текущий темп пополнения дальше
  const far = forecastBeyondPlan(sim, goal, i);
  if (far) {
    return {
      label: m.deadline ? `позже срока (прогноз ${fmt.date(far.date)})` : `прогноз: к ${fmt.date(far.date)}`,
      cls: m.deadline ? 'warn' : '',
      done: far.date, beyondPlan: true,
    };
  }
  return {
    label: m.deadline ? `не достигается к ${fmt.date(m.deadline)}` : 'пока не пополняется',
    cls: 'danger',
  };
}

/* Подраздел внутри карточки цели: заголовок с шевроном, содержимое по клику */
function sub(ctx, key, title, actions, body) {
  const open = ctx.ui.open.has(key);
  return `<div class="sub-section${open ? ' open' : ''}">
    <div class="card-title">
      <button class="section-head" data-toggle="${esc(key)}" aria-expanded="${open ? 'true' : 'false'}">
        <span class="chev${open ? ' open' : ''}">▸</span><h3>${esc(title)}</h3></button>
      ${actions ? `<div class="row wrap" style="gap:8px;">${actions}</div>` : ''}
    </div>
    ${open ? body : ''}
  </div>`;
}

/* Карточка цели. Подушки показывают то же самое плюс темп (reserves.js). */
export function goalCard(ctx, g, { extraFields = '', canDelete = true, showCycles = true, showPriority = true } = {}) {
  const { state, fmt, canEdit, sim, ui } = ctx;
  const milestones = (state.savings?.goal_milestones ?? []).filter(m => m.goal_id === g.id);
  const txs = (state.savings?.goal_transactions ?? []).filter(t => t.goal_id === g.id)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const goalsById = new Map((state.savings?.goals ?? []).map(x => [x.id, x]));
  const currencies = ctx.cfg.list('currencies').map(c => ({ value: c.code, label: c.code }));

  const total = goalTotal(g, state.savings?.goal_milestones ?? []);
  const hasTarget = total > 0;
  const progress = goalProgressAt(sim, g, sim.planEnd || ctx.today);
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(progress / total * 100))) : 0;
  const balance = goalBalanceAt(sim, g, state.savings?.goal_transactions ?? [], ctx.today);
  const cycleCount = (state.savings?.goal_cycles ?? []).filter(c => c.goal_id === g.id).length;
  /* Метка под шкалой: что с целью дальше. У цели без этапов это она сама,
     у цели с этапами — ближайший незакрытый этап. */
  const allMs = sim.milestonesOf(g);
  const msDates = sim.milestoneDates[g.id] ?? [];
  const nextMs = allMs.find((m, i) => msDates[i] !== 'pre') ?? allMs[allMs.length - 1] ?? null;
  const mainStatus = nextMs ? milestoneStatus(ctx, g, nextMs) : null;

  const msRows = milestones.slice().sort((a, b) => ((a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1)).map(m => {
    const { label, cls } = milestoneStatus(ctx, g, m);
    const generated = m.source && m.source !== 'manual';
    const spent = (state.savings?.goal_transactions ?? []).some(t => t.milestone_id === m.id);
    return `<div class="ms-row">
      ${input({ edit: 'savings|goal_milestones|title', key: { id: m.id }, value: m.title, placeholder: 'Этап', disabled: !canEdit })}
      ${input({ edit: 'savings|goal_milestones|target', key: { id: m.id }, value: m.target, type: 'money',
        placeholder: 'Сколько накопить', disabled: !canEdit, defaults: { user_edited: true } })}
      ${input({ edit: 'savings|goal_milestones|deadline', key: { id: m.id }, value: m.deadline, type: 'date', disabled: !canEdit })}
      ${canEdit ? delButton({ domain: 'savings', table: 'goal_milestones', key: { id: m.id } }) : ''}
      <div class="ms-foot row wrap">
        ${pill(label, cls)}
        ${canEdit && showCycles && !generated ? button({ action: 'make-cycle', value: `ms:${m.id}`, label: 'сделать периодичным', cls: 'ghost small',
          title: 'Повторять этот этап через равные промежутки' }) : ''}
        ${canEdit && !spent ? button({ action: 'ms-spend', value: m.id, label: 'создать трату', cls: 'ghost small',
          title: 'Списать накопленное в дату этапа' }) : ''}
        ${generated ? `<span class="small-note" style="margin:0;">${m.source === 'gift' ? 'из праздника' : 'из повторяющегося накопления'}${
          m.user_edited ? ' · правка сохранена, шаблон его больше не трогает' : ' · правка здесь закрепит этап за вами'}</span>
          ${canEdit && m.user_edited ? button({ action: 'edit-generated', value: `back:${m.id}`, label: 'вернуть к шаблону', cls: 'ghost small',
            title: 'Снова вести этот этап по шаблону — ваша правка пропадёт' }) : ''}` : ''}
      </div>
    </div>`;
  }).join('');

  const txRows = txs.map(t => {
    const other = t.counterparty_id ? goalsById.get(t.counterparty_id) : null;
    const kindCell = isTransfer(t)
      ? `<div style="padding-top:8px;">${pill(t.kind === 'transfer_out' ? `перевод в «${other?.title ?? '—'}»` : `перевод из «${other?.title ?? '—'}»`)}</div>`
      : select({ edit: 'savings|goal_transactions|kind', key: { id: t.id }, value: t.kind, disabled: !canEdit,
          options: [{ value: 'spend', label: 'трата' }, { value: 'deposit', label: 'пополнение' }] });
    return `<div class="item-row wd-row" style="grid-template-columns:1fr 1.4fr 1.2fr 1fr auto;align-items:end;">
      ${field('Дата', input({ edit: 'savings|goal_transactions|date', key: { id: t.id }, value: t.date, type: 'date', disabled: !canEdit }))}
      ${field('Название', input({ edit: 'savings|goal_transactions|title', key: { id: t.id }, value: t.title, disabled: !canEdit }))}
      ${field('Операция', kindCell)}
      ${field('Сумма', input({ edit: 'savings|goal_transactions|amount', key: { id: t.id }, value: t.amount, type: 'money', disabled: !canEdit }))}
      ${canEdit ? delButton({ domain: 'savings', table: 'goal_transactions', key: { id: t.id },
        confirm: isTransfer(t) ? 'Удалить перевод? Он исчезнет в обеих целях.' : undefined }) : ''}
    </div>`;
  }).join('');

  return `<div class="card goal-card">
    <div class="goal-head row between wrap">
      <input class="goal-title" data-edit="savings|goals|title" data-key='{"id":"${esc(g.id)}"}'
        value="${esc(g.title)}" placeholder="Название"${canEdit ? '' : ' disabled'}>
      <div class="row wrap" style="gap:6px;align-items:center;">
        ${g.completed ? pill('закрыта', 'ok') : ''}
        ${showPriority ? pill(`приоритет ${g.priority ?? '—'}`) : ''}
        ${showPriority ? button({ action: 'goal-move', value: `${g.id}:up`, label: '↑', cls: 'ghost small', disabled: !canEdit, title: 'Выше в очереди' }) : ''}
        ${showPriority ? button({ action: 'goal-move', value: `${g.id}:down`, label: '↓', cls: 'ghost small', disabled: !canEdit, title: 'Ниже в очереди' }) : ''}
        ${canEdit && canDelete ? delButton({ domain: 'savings', table: 'goals', key: { id: g.id },
          confirm: `Удалить «${g.title}» вместе с этапами, движениями и ручными суммами?` }) : ''}
      </div>
    </div>
    ${hasTarget ? `<div class="progress"><i style="width:${pct}%"></i></div>
      <div class="row between wrap" style="gap:8px;">
        <span class="small-note" style="margin:0;">${esc(fmt.money(progress, g.currency_code))} / ${esc(fmt.money(total, g.currency_code))} (${pct}%) ·
          на счету сейчас (${esc(fmt.date(ctx.today))}): <b>${esc(fmt.money(balance, g.currency_code))}</b></span>
        ${mainStatus ? pill(`${milestones.length ? esc(nextMs.title || 'этап') + ': ' : ''}${mainStatus.label}`, mainStatus.cls) : ''}
      </div>`
      : `<div class="small-note">на счету сейчас (${esc(fmt.date(ctx.today))}): <b>${esc(fmt.money(balance, g.currency_code))}</b>.
        Прогноза нет: не задана сумма цели и нет этапов.</div>`}
    <div class="row wrap" style="gap:12px;margin-top:12px;align-items:end;">
      <div style="width:120px;">${field('Валюта', select({ edit: 'savings|goals|currency_code', key: { id: g.id }, value: g.currency_code, options: currencies, disabled: !canEdit }))}</div>
      <div style="width:160px;">${field('Начальный остаток', input({ edit: 'savings|goals|starting_balance', key: { id: g.id }, value: g.starting_balance, type: 'money', disabled: !canEdit }))}</div>
      ${canEdit ? (`<div class="row wrap goal-actions" style="gap:8px;">
        ${button({ action: 'goal-close', value: g.id, label: g.completed ? 'Вернуть в работу' : 'Закрыть цель',
          cls: g.completed ? 'ghost small' : 'small',
          title: g.completed ? 'Цель снова участвует в распределении' : 'Цель перестанет получать деньги: в будущих выплатах её не будет, в зафиксированных останется' })}
        ${button({ action: 'transfer-open', value: g.id, label: 'Перевести в другую цель', cls: 'ghost small' })}
      </div>`) : ''}
    </div>
    ${extraFields}
    ${!milestones.length ? `<div class="row wrap" style="gap:12px;margin-top:12px;align-items:end;">
        <div style="flex:1;min-width:160px;">${field('Сколько накопить', input({ edit: 'savings|goals|target_amount', key: { id: g.id }, value: g.target_amount, type: 'money', disabled: !canEdit }))}</div>
        <div style="flex:1;min-width:160px;">${field('К дате', input({ edit: 'savings|goals|deadline', key: { id: g.id }, value: g.deadline, type: 'date', disabled: !canEdit }))}</div>
        ${canEdit && showCycles ? `<div class="row goal-actions">${button({ action: 'make-cycle', value: `goal:${g.id}`, label: 'Сделать периодической',
          title: 'Копить эту сумму к дате и повторять' })}</div>` : ''}
      </div>
      <div class="small-note">Или разбейте цель на этапы ниже — тогда сумма сложится из них.</div>` : ''}
    ${canEdit && g.completed && balance > 0.5 ? `<div class="row wrap" style="gap:8px;margin-top:12px;">
      ${button({ action: 'redistribute', value: g.id, label: `Раздать остаток ${fmt.money(balance, g.currency_code)} другим целям` })}</div>` : ''}

    ${sub(ctx, `goal:${g.id}`, `Этапы${milestones.length ? ` · ${milestones.length}` : ''}`,
      canEdit ? addButton({ domain: 'savings', table: 'goal_milestones', label: '+ этап',
        row: { id: uid('ms'), goal_id: g.id, title: 'Новый этап', target: 0, deadline: null, source: 'manual', user_edited: false, sort_order: milestones.length + 1 } }) : '',
      `<div class="small-note" style="margin-top:0;">Этапы — приросты: следующий начинается с нуля, общая сумма цели складывается из них.</div>
       ${msRows || '<div class="small-note">Этапов нет — цель копится одной суммой.</div>'}`)}

    ${sub(ctx, `goal-tx:${g.id}`, `Движения и переводы${txs.length ? ` · ${txs.length}` : ''}`,
      canEdit ? addButton({ domain: 'savings', table: 'goal_transactions', label: '+ трата или пополнение',
        row: { id: uid('tx'), goal_id: g.id, date: ctx.today, amount: 0, kind: 'spend', title: '', source: 'manual', user_edited: false } }) : '',
      `<div class="small-note" style="margin-top:0;">Траты из копилки, пополнения со стороны и переводы между целями.</div>
       ${txRows || '<div class="small-note">Движений пока нет.</div>'}
       ${transferForm(ctx, g)}`)}

    ${showCycles ? sub(ctx, `goal-cyc:${g.id}`, `Повторяющиеся накопления${cycleCount ? ` · ${cycleCount}` : ''}`, '', cyclesBlock(ctx, g)) : ''}
  </div>`;
}

export function render(ctx) {
  const { state, canEdit } = ctx;
  const goals = (state.savings?.goals ?? []).filter(g => g.kind_code === 'bucket')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return `
    <div class="row between wrap" style="gap:8px;">
      ${pill('Копилка — цель с оборотом: копим к сроку, тратим, копим снова')}
      ${canEdit ? addButton({ domain: 'savings', table: 'goals', cls: 'primary small', label: '+ копилка',
        row: { id: uid('goal'), title: 'Новая копилка', kind_code: 'bucket', currency_code: ctx.cfg.get('base_currency'),
          priority: goals.length + 1, target_amount: 0, deadline: null, starting_balance: 0, pace_amount: 0, completed: false } }) : ''}
    </div>
    ${goals.map(g => goalCard(ctx, g)).join('') || '<div class="card muted">Копилок пока нет.</div>'}`;
}

export function handle(ev, ctx) {
  const { store, ui } = ctx;

  const move = ev.target.closest('[data-goal-move]');
  if (move) {
    const [id, dir] = move.dataset.goalMove.split(':');
    return moveGoal(ctx, id, dir);
  }

  // этап или цель целиком превращаются в повторяющееся накопление
  const mk = ev.target.closest('[data-make-cycle]');
  if (mk) {
    const [what, id] = mk.dataset.makeCycle.split(':');
    const st = ctx.state.savings ?? {};
    const src = what === 'ms'
      ? (st.goal_milestones ?? []).find(m => m.id === id)
      : (st.goals ?? []).find(g => g.id === id);
    if (!src) return false;
    const goalId = what === 'ms' ? src.goal_id : src.id;
    const amount = Number(what === 'ms' ? src.target : src.target_amount) || 0;
    const start = (what === 'ms' ? src.deadline : src.deadline) || `${ctx.year}-12-31`;
    const goal = (st.goals ?? []).find(g => g.id === goalId);
    store.update('savings', d => {
      (d.goal_cycles ?? (d.goal_cycles = [])).push({
        id: uid('cycle'), goal_id: goalId, title: (what === 'ms' ? src.title : goal?.title) || 'Накопление',
        amount, every_n: 1, period_unit: 'year', start_date: start, repeats: null, auto_spend: true, enabled: true,
      });
      if (what === 'ms') d.goal_milestones = d.goal_milestones.filter(m => m.id !== id);
      else {
        const g = d.goals.find(x => x.id === id);
        if (g) { g.target_amount = 0; g.deadline = null; }
      }
    });
    ui.open.add(`goal-cyc:${goalId}`);
    return true;
  }

  // закрытие цели: в будущих выплатах её больше нет, в зафиксированных остаётся
  const close = ev.target.closest('[data-goal-close]');
  if (close) {
    const id = close.dataset.goalClose;
    store.update('savings', d => {
      const g = d.goals.find(x => x.id === id);
      if (g) g.completed = !g.completed;
    });
    return true;
  }

  // трата по этапу: списываем накопленное в дату этапа
  const spend = ev.target.closest('[data-ms-spend]');
  if (spend) {
    const id = spend.dataset.msSpend;
    const m = (ctx.state.savings?.goal_milestones ?? []).find(x => x.id === id);
    if (!m) return false;
    store.update('savings', d => {
      (d.goal_transactions ?? (d.goal_transactions = [])).push({
        id: uid('tx'), goal_id: m.goal_id, date: m.deadline || ctx.today, amount: Number(m.target) || 0,
        kind: 'spend', title: m.title || 'Трата', counterparty_id: null, milestone_id: m.id,
        source: 'manual', user_edited: true,
      });
    });
    ui.open.add(`goal-tx:${m.goal_id}`);
    return true;
  }

  // вернуть этап под управление шаблона: снимаем признак правки и у него, и у его траты
  const unpin = ev.target.closest('[data-edit-generated]');
  if (unpin) {
    const id = unpin.dataset.editGenerated.replace(/^back:/, '');
    store.update('savings', d => {
      const m = (d.goal_milestones ?? []).find(x => x.id === id);
      if (m) m.user_edited = false;
      for (const t of (d.goal_transactions ?? []).filter(x => x.milestone_id === id)) t.user_edited = false;
    });
    return true;
  }

  const open = ev.target.closest('[data-transfer-open]');
  if (open) {
    const goalId = open.dataset.transferOpen;
    const first = (ctx.state.savings?.goals ?? []).find(g => g.id !== goalId);
    ui.draft.transfer = { goal_id: goalId, to: first?.id ?? '', amount: '', date: ctx.today, title: 'Перевод' };
    ui.open.add(`goal-tx:${goalId}`);   // форма живёт в разделе движений — открываем его
    return true;
  }

  if (ev.target.closest('[data-transfer-cancel]')) { ui.draft.transfer = null; return true; }

  const apply = ev.target.closest('[data-transfer-apply]');
  if (apply) {
    const draft = { ...ui.draft.transfer, ...(ui.draft[ctx.ui.tab] ?? {}) };
    const from = apply.dataset.transferApply;
    const amount = ctx.fmt.parseMoney(draft.amount);
    if (!draft.to || !(amount > 0)) throw new Error('Укажите цель и сумму перевода');
    const key = `transfer:${uid('t')}`;
    const title = draft.title || 'Перевод';
    store.update('savings', d => {
      d.goal_transactions.push(
        { id: uid('tx'), goal_id: from, date: draft.date, amount, kind: 'transfer_out', title,
          counterparty_id: draft.to, occurrence_key: key, source: 'manual', user_edited: false },
        { id: uid('tx'), goal_id: draft.to, date: draft.date, amount, kind: 'transfer_in', title,
          counterparty_id: from, occurrence_key: key, source: 'manual', user_edited: false },
      );
    });
    ui.draft.transfer = null;
    ui.draft[ctx.ui.tab] = {};
    return true;
  }

  const red = ev.target.closest('[data-redistribute]');
  if (red) {
    const goal = ctx.state.savings.goals.find(g => g.id === red.dataset.redistribute);
    const txs = ctx.state.savings.goal_transactions ?? [];
    const balance = goalBalanceAt(ctx.sim, goal, txs, ctx.today);
    const offer = proposeRedistribution(ctx.sim, goal, balance, ctx.today, txs).filter(o => o.amount > 0);
    if (!offer.length) throw new Error('Некуда переводить: у других целей всё набрано');
    const total = offer.reduce((s, o) => s + o.amount, 0);
    const text = offer.map(o => `${o.title}: ${ctx.fmt.money(o.amount)}`).join('\n');
    if (!window.confirm(`Перевести ${ctx.fmt.money(total)} из «${goal.title}»?\n\n${text}`)) return false;
    store.update('savings', d => {
      for (const o of offer) {
        const key = `transfer:${uid('t')}`;
        d.goal_transactions.push(
          { id: uid('tx'), goal_id: goal.id, date: ctx.today, amount: o.amount, kind: 'transfer_out',
            title: `Перевод в «${o.title}»`, counterparty_id: o.goal_id, occurrence_key: key, source: 'manual', user_edited: false },
          { id: uid('tx'), goal_id: o.goal_id, date: ctx.today, amount: o.amount, kind: 'transfer_in',
            title: `Перевод из «${goal.title}»`, counterparty_id: goal.id, occurrence_key: key, source: 'manual', user_edited: false },
        );
      }
    });
    return true;
  }
  return false;
}
