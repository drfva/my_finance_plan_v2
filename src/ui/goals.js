/* Копилки: цели с этапами, движениями, переводами и повторяющимися накоплениями */

import { esc, input, select, checkbox, addButton, delButton, button, pill, field } from './dom.js';
import { uid } from './edit.js';
import { goalBalanceAt, proposeRedistribution, forecastBeyondPlan, snapshotGoalCompletion } from '../engine/allocation.js';
import { cycleDates, normalizeGoalPriorities } from '../engine/savings.js';
import {renderGoalCard} from './goal-card.js';
import {handleGoalCardAction} from './goal-operations.js';

export const code = 'goals';
export const title = () => 'Копилки';


/* Приоритет меняется стрелками: цели этого же типа нумеруются заново */
export function moveGoal(ctx, id, dir) {
  const { store, state } = ctx;
  const goal = (state.savings?.goals ?? []).find(g => g.id === id);
  if (!ctx.canEdit || !goal || goal.completed || goal.archived) return false;
  const list = (state.savings?.goals ?? []).filter(g => g.kind_code === goal.kind_code && !g.completed && !g.archived)
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

function cyclesBlock(ctx, goal) {
  const { state, fmt, canEdit, cfg } = ctx;
  const cycles = (state.savings?.goal_cycles ?? []).filter(c => c.goal_id === goal.id);
  const units = cfg.list('period_units').map(u => ({ value: u.code, label: u.title }));
  const planEnd = `${Math.max(...(ctx.years?.length?ctx.years:[ctx.year]))}-12-31`;

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
    if (goal.completed && goal.completion_snapshot) {
      return { label: done === 'pre' ? 'уже накоплено' : `накоплено ${fmt.date(done)}`,
        cls: 'ok', done };
    }
    const label = (done === 'pre' ? 'уже накоплено'
      : m.deadline ? (done <= m.deadline ? `в графике (к ${fmt.date(done)})` : `позже срока (к ${fmt.date(done)})`)
      : `прогноз: к ${fmt.date(done)}`);
    const cls = (!m.deadline || done === 'pre' || done <= m.deadline) ? 'ok' : 'warn';
    return { label, cls, done };
  }
  if (goal.completed) return { label: 'не накоплено до закрытия цели', cls: '', done: null };
  // внутри плана этап не закрывается — продлеваем текущий темп пополнения дальше
  const far = forecastBeyondPlan(sim, goal, i);
  if (far) {
    const late = m.deadline && far.date > m.deadline;
    return {
      label: m.deadline ? `${late ? 'позже срока' : 'в графике'} (прогноз ${fmt.date(far.date)})` : `прогноз: к ${fmt.date(far.date)}`,
      cls: m.deadline ? (late ? 'warn' : 'ok') : '',
      done: far.date, beyondPlan: true,
    };
  }
  return {
    label: m.deadline ? `не достигается к ${fmt.date(m.deadline)}` : 'пока не пополняется',
    cls: 'danger',
  };
}

/* В шапке — ближайшая будущая дата срока или прогноза, включая сегодня.
   Предупреждение проверяет все этапы, даже когда их список свёрнут. */
export function goalSummary(ctx, goal) {
  const stages = ctx.sim.milestonesOf(goal).map(m => ({ m, status: milestoneStatus(ctx, goal, m) }));
  const upcoming = stages.map(x => {
    const dates = [x.m.deadline, x.status.done].filter(d => d && d !== 'pre' && d >= ctx.today);
    return { ...x, date: dates.sort()[0] };
  }).filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date));
  return {
    next: upcoming[0] ?? null,
    late: !goal.completed && !goal.archived && stages.some(x => x.status.cls === 'warn'),
  };
}

/* Архив хранит закрытые цели отдельно от основного списка. */
export function goalList(ctx, goals, renderCard, kind) {
  const visible = goals.filter(g => !g.archived);
  const archived = goals.filter(g => g.archived);
  const key = `goal-archive:${kind}`;
  const open = ctx.ui.open.has(key);
  return `${visible.map(renderCard).join('') || '<div class="card muted">Целей вне архива пока нет.</div>'}
    <div class="row" style="margin-top:16px;">
      <button class="ghost small" data-toggle="${key}" aria-expanded="${open}">${open ? 'Закрыть архив' : 'Архив'} (${archived.length})</button>
    </div>
    ${open ? `<section class="goal-archive" aria-label="Архив целей"><h3>Архив</h3>
      ${archived.map(renderCard).join('') || '<div class="small-note">В архиве пока нет целей.</div>'}</section>` : ''}`;
}

function currencyPicker(ctx,g) {
  const current=ctx.cfg.currency(g.currency_code),key=`goal-currency:${g.id}`,open=ctx.ui.open.has(key);
  return `<div class="goal-currency-picker"><button class="ghost goal-currency-toggle" data-goal-currency-toggle="${esc(g.id)}"
    aria-label="Выбрать валюту: ${esc(g.currency_code)}" title="${esc(current?.title||g.currency_code)}" aria-expanded="${open}"
    aria-controls="currency-palette-${esc(g.id)}"${ctx.canEdit?'':' disabled'}>${esc(current?.symbol||g.currency_code)}</button>
    ${open&&ctx.canEdit?`<div class="goal-currency-options" id="currency-palette-${esc(g.id)}" role="group" aria-label="Валюта цели">
      ${ctx.cfg.list('currencies').map(c=>`<button class="goal-currency-option" data-goal-currency="${esc(g.id)}" data-currency="${esc(c.code)}"
        title="${esc(c.title||c.code)}" aria-label="${esc(c.code)}" aria-pressed="${c.code===g.currency_code}">
        <span aria-hidden="true">${esc(c.symbol||c.code)}</span><span class="currency-code" aria-hidden="true">${esc(c.code)}</span></button>`).join('')}
    </div>`:''}</div>`;
}

/* Карточка цели. Подушки показывают то же самое плюс темп (reserves.js). */
export function goalCard(ctx,g,options={}) {
  return renderGoalCard(ctx,g,options,{milestoneStatus,goalSummary,cyclesBlock,currencyPicker});
}

export function render(ctx) {
  const { state, canEdit } = ctx;
  const goals = (state.savings?.goals ?? []).filter(g => g.kind_code === 'bucket')
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
  return `
    <div class="row between wrap" style="gap:8px;">
      ${pill('Копилка — цель с оборотом: копим к сроку, тратим, копим снова')}
      ${canEdit ? addButton({ domain: 'savings', table: 'goals', cls: 'primary small', label: '+ копилка',
        row: { id: uid('goal'), title: 'Новая копилка', kind_code: 'bucket', currency_code: ctx.cfg.get('base_currency'),
          priority: goals.filter(g => !g.completed && !g.archived).length + 1, target_amount: 0, deadline: null, starting_balance: 0, pace_amount: 0, completed: false } }) : ''}
    </div>
    ${goalList(ctx, goals, g => goalCard(ctx, g), 'bucket')}`;
}

export function handle(ev, ctx) {
  const { store, ui } = ctx;
  const cardAction=handleGoalCardAction(ev,ctx);
  if(cardAction!==null)return cardAction;
  const currencyToggle=ev.target.closest('[data-goal-currency-toggle]'),currencyChoice=ev.target.closest('[data-goal-currency]');
  if(currencyToggle||currencyChoice){
    if(!ctx.canEdit)return false;
    const id=currencyToggle?.dataset.goalCurrencyToggle??currencyChoice.dataset.goalCurrency;
    const goal=ctx.state.savings?.goals?.find(g=>g.id===id);
    if(!goal)return false;
    const key=`goal-currency:${id}`,wasOpen=ui.open.has(key);
    if(currencyChoice&&!ctx.cfg.currency(currencyChoice.dataset.currency))return false;
    for(const open of [...ui.open])if(open.startsWith('goal-currency:'))ui.open.delete(open);
    if(currencyToggle){if(!wasOpen)ui.open.add(key);}
    else store.update('savings',d=>{d.goals.find(g=>g.id===id).currency_code=currencyChoice.dataset.currency;});
    return true;
  }

  const archive = ev.target.closest('[data-goal-archive]');
  const show = ev.target.closest('[data-goal-show-overview]');
  const eye = ev.target.closest('[data-goal-toggle-overview]');
  if (archive || show || eye) {
    if (!ctx.canEdit) return false;
    const goal = (ctx.state.savings?.goals ?? []).find(g => g.id === (archive?.dataset.goalArchive ?? show?.dataset.goalShowOverview ?? eye.dataset.goalToggleOverview));
    if (!goal || (archive && (!goal.completed || !['bucket', 'reserve'].includes(goal.kind_code)))) return false;
    if (eye && !['bucket', 'reserve'].includes(goal.kind_code)) return false;
    store.update('savings', d => {
      const g = d.goals.find(x => x.id === goal.id);
      if (archive) { g.archived = !g.archived; g.priority = null; }
      else if (eye) g.hidden_overview = !g.hidden_overview;
      else g.hidden_overview = false;
    });
    return true;
  }

  // «История баланса» — отдельная вкладка с движениями по этой копилке
  const led = ev.target.closest('[data-ledger-open]');
  if (led) { ui.goal = led.dataset.ledgerOpen; ui.tab = 'ledger'; ui.open.clear(); return true; }

  const move = ev.target.closest('[data-goal-move]');
  if (move) {
    const [id, dir] = move.dataset.goalMove.split(':');
    return moveGoal(ctx, id, dir);
  }

  // закрытие цели: в будущих выплатах её больше нет, в зафиксированных остаётся
  const close = ev.target.closest('[data-goal-close]');
  if (close) {
    if (!ctx.canEdit) return false;
    const id = close.dataset.goalClose;
    const goal = ctx.state.savings.goals.find(g => g.id === id);
    if (!goal) return false;
    const snapshot = goal.completed ? null : snapshotGoalCompletion(ctx.sim, goal, ctx.today);
    store.update('savings', d => {
      const g = d.goals.find(x => x.id === id);
      if (g && !g.completed) {
        // Включая сегодняшнюю выплату: закрытие не должно убирать уже накопленные
        // отчисления, даже если сама выплата ещё не зафиксирована.
        const overrides = d.savings_period_overrides ?? (d.savings_period_overrides = []);
        for (const r of ctx.sim.rows) {
          const amount = r.allocations[id] ?? 0;
          if (r.period.pay_date > ctx.today || amount <= 0) continue;
          const own = overrides.find(o => o.period_id === r.period.id && o.goal_id === id);
          if (own) own.amount = amount;
          else overrides.push({ period_id: r.period.id, goal_id: id, amount });
        }
      }
      if (g) {
        g.completed = !g.completed;
        g.completion_snapshot = snapshot;
        g.priority = null;
        if (!g.completed) g.archived = false;
        const normalized = normalizeGoalPriorities(d.goals);
        d.goals.forEach((goal, i) => { goal.priority = normalized[i].priority; });
      }
    });
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
