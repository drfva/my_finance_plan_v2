/* ---------------------------------------------------------------------
   app.js — оболочка: шапка, вкладки, выбор года и общий расчёт.

   Расчёт делается один раз на отрисовку (allocation.simulate) и передаётся
   вкладкам. Правка данных идёт через edit.js, поэтому вкладки — это почти
   только разметка.
--------------------------------------------------------------------- */

import { esc, byId } from './dom.js';
import { attachEditing } from './edit.js';
import { simulate, freezePeriods } from '../engine/allocation.js';
import { computeIncome } from '../engine/income.js';
import { createSecurity } from '../core/security.js';
import { syncGenerated } from '../engine/savings.js';

import * as dashboard from './dashboard.js';
import * as periods from './periods.js';
import * as categories from './categories.js';
import * as facts from './facts.js';
import * as goals from './goals.js';
import * as gifts from './gifts.js';
import * as reserves from './reserves.js';
import * as credits from './credits.js';
import * as installments from './installments.js';
import * as vacations from './vacations.js';
import * as settings from './settings.js';
import { attachSettings } from './settings.js';

const TABS = [dashboard, periods, categories, facts, goals, gifts, reserves, credits, installments, vacations, settings];

const STATUS_TEXT = { pending: 'Сохранение…', saving: 'Сохранение…', saved: 'Сохранено', error: 'Ошибка сохранения' };

export const ROLE_TITLES = {
  owner: 'владелец',
  editor: 'редактор',
  viewer: 'читатель — только просмотр',
};

/* Годы плана: и те, где уже есть выплаты, и те, где пока задан только график.
   Пока нет ничего — предлагаем следующий календарный год. */
export function planYears(state, today) {
  const inc = state.income ?? {};
  const list = [...new Set([
    ...(inc.periods ?? []).map(p => Number(p.year)),
    ...(inc.plan_years ?? []).map(y => Number(y.year)),
    ...(inc.payout_slots ?? []).map(s => Number(s.year)),
  ])].filter(Number.isFinite).sort((a, b) => a - b);
  return list.length ? list : [Number(today.slice(0, 4)) + 1];
}

export function createApp({ store, env = 'prod', client = null, onSignOut }) {
  const ui = { tab: null, year: null, open: new Set(), draft: {}, notice: null };
  const security = client ? createSecurity(client, () => render()) : null;
  let lastSync = '';

  const cfg = () => store.config();
  const fmt = () => cfg().formatter();

  const years = () => planYears(store.state, fmt().todayISO());

  function context() {
    const state = store.state;
    const c = cfg();
    const f = c.formatter();
    const income = computeIncome(state, c, { round: f.round });
    const sim = simulate(state, c, { income, round: f.round });
    const list = years();
    if (!list.includes(ui.year)) ui.year = list.includes(Number(f.todayISO().slice(0, 4))) ? Number(f.todayISO().slice(0, 4)) : list[0];
    return { store, state, cfg: c, fmt: f, income, sim, ui, year: ui.year, years: list, today: f.todayISO(), canEdit: c.canEdit, security, onSignOut };
  }

  /* Циклы и праздники разворачиваются в этапы и траты при изменении данных */
  function syncGeneratedRows(ctx) {
    if (!ctx.canEdit) return;
    // горизонт плана — часть ключа: создали выплаты нового года, и циклы должны
    // развернуться дальше, даже если сами циклы не менялись
    const until = (ctx.state.income?.periods ?? []).reduce((m, p) => (p.pay_date > m ? p.pay_date : m), '');
    const key = JSON.stringify([ctx.state.savings?.goal_cycles, ctx.state.savings?.goal_cycle_skips, ctx.state.gifts, ctx.years, until]);
    if (key === lastSync) return;
    lastSync = key;
    const res = syncGenerated({
      savings: ctx.state.savings ?? {},
      gifts: ctx.state.gifts ?? {},
      until,
      years: ctx.years,
      today: ctx.today,
      units: ctx.cfg.list('period_units'),
      goalKinds: Object.fromEntries(ctx.cfg.list('goal_kinds').map(k => [k.code, k.stage_code])),
    });
    if (res.changed) {
      store.update('savings', sv => { sv.goal_milestones = res.goal_milestones; sv.goal_transactions = res.goal_transactions; });
    }
  }

  /* Копилка подарков нужна всегда: праздники складывают деньги именно в неё */
  function ensureGiftsGoal(ctx) {
    if (!ctx.canEdit) return false;
    if ((ctx.state.savings?.goals ?? []).some(g => g.kind_code === 'gifts')) return false;
    store.update('savings', d => {
      (d.goals ?? (d.goals = [])).push({
        id: 'goal-gifts', title: 'Подарки', kind_code: 'gifts', currency_code: ctx.cfg.get('base_currency'),
        priority: (d.goals?.length ?? 0) + 1, target_amount: 0, deadline: null, starting_balance: 0,
        pace_amount: 0, completed: false,
      });
    });
    return true;
  }

  /* Прошедшие выплаты фиксируются: расчёт превращается в факт и больше не меняется */
  function freezePast(ctx) {
    if (!ctx.canEdit) return false;
    const ids = ctx.sim.rows.filter(r => !r.period.locked && r.period.pay_date < ctx.today).map(r => r.period.id);
    if (!ids.length) return false;
    const patch = freezePeriods(ctx.state, ctx.sim, ids, ctx.fmt.round);
    store.update('income', d => { d.periods = patch.periods; });
    store.update('savings', d => { d.savings_period_overrides = patch.savings_period_overrides; });
    store.update('debts', d => { d.credit_payment_overrides = patch.credit_payment_overrides; });
    return true;
  }

  function tabsHtml(ctx) {
    return TABS.map(t => `<button class="${t.code === ui.tab ? 'active' : ''}" data-tab="${t.code}">${esc(t.title(ctx))}</button>`).join('');
  }

  function shell(ctx, body) {
    const tab = TABS.find(t => t.code === ui.tab);
    const yearBtns = ctx.years.length > 1 && tab?.hasYears
      ? `<div class="month-tabs" style="margin:0;">${ctx.years.map(y =>
          `<button class="${y === ctx.year ? 'active' : ''}" data-year="${y}">${y}</button>`).join('')}</div>`
      : '';
    const tabActions = tab?.actions ? tab.actions(ctx) : '';
    const topRow = yearBtns || tabActions
      ? `<div class="row between wrap" style="gap:10px;margin-bottom:14px;">${yearBtns || '<span></span>'}
          <div class="row wrap" style="gap:8px;">${tabActions}</div></div>`
      : '';
    return `
      <div class="topbar"><div class="topbar-inner">
        <div class="brand"><h1 style="font-size:19px;">${esc(ctx.state.account?.title || 'Финансы')}</h1>
          ${env === 'dev' ? '<span class="pill danger" style="font-size:11px;">ТЕСТ</span>' : ''}
          ${ctx.canEdit ? '' : '<span class="pill" style="font-size:11px;">только просмотр</span>'}
          ${ctx.years.length ? `<span class="pill" style="font-size:11px;">${esc(ROLE_TITLES[ctx.state.account?.role] ?? ctx.state.account?.role ?? '')}</span>` : ''}
        </div>
        <div class="topbar-right">
          <span class="savebadge" id="save-badge"></span>
          <span class="today-date">Сегодня <b>${esc(ctx.fmt.date(ctx.today, 'weekday'))}</b></span>
          <button class="ghost small" id="sign-out">Выйти</button>
        </div>
      </div>
      <nav class="tabs">${tabsHtml(ctx)}</nav>
      </div>
      <main>
        ${ui.notice ? `<div class="info-box row between" style="background:var(--${ui.notice.kind}-soft);color:var(--${ui.notice.kind});">
          <span>${esc(ui.notice.text)}</span><button class="ghost small" id="notice-close">×</button></div>` : ''}
        ${topRow}
        ${body}
      </main>`;
  }

  function render() {
    const ctx = context();
    if (ensureGiftsGoal(ctx)) return;  // состояние изменилось — отрисовка придёт событием
    syncGeneratedRows(ctx);
    if (freezePast(ctx)) return;      // состояние изменилось — отрисовка придёт событием
    if (!ui.tab || !TABS.some(t => t.code === ui.tab)) {
      const start = ctx.cfg.get('start_tab');
      ui.tab = TABS.some(t => t.code === start) ? start : 'dashboard';
    }
    const tab = TABS.find(t => t.code === ui.tab);
    let body;
    try {
      body = tab.render(ctx);
    } catch (e) {
      console.error(e);
      body = `<div class="card"><h2>Не получилось показать вкладку</h2><p class="muted">${esc(e.message)}</p></div>`;
    }
    byId('root').innerHTML = shell(ctx, body);
    byId('sign-out').addEventListener('click', async () => { await store.flush(); onSignOut(); });
    const close = byId('notice-close');
    if (close) close.addEventListener('click', () => { ui.notice = null; render(); });
    renderStatus(store.status());
    // активная вкладка всегда видна: список вкладок прокручивается по горизонтали
    document.querySelector('nav.tabs button.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  }

  function renderStatus(status) {
    const b = byId('save-badge');
    if (!b) return;
    b.textContent = STATUS_TEXT[status] ?? '';
    b.style.color = status === 'error' ? 'var(--danger)' : '';
  }

  function notice(kind, text) {
    ui.notice = { kind, text };
    render();
  }

  function start() {
    const root = byId('root');
    attachEditing(root, store, context, e => notice('danger', e.message));
    attachSettings(root, store, context);

    // черновики форм живут в памяти вкладки и не перерисовывают экран
    root.addEventListener('change', ev => {
      const el = ev.target.closest('[data-draft]');
      if (!el) return;
      const draft = ui.draft[ui.tab] ?? (ui.draft[ui.tab] = {});
      draft[el.dataset.draft] = el.type === 'checkbox' ? el.checked : el.value;
    });

    root.addEventListener('click', ev => {
      const tab = ev.target.closest('[data-tab]');
      if (tab) { ui.tab = tab.dataset.tab; ui.open.clear(); render(); return; }
      const year = ev.target.closest('[data-year]');
      if (year) { ui.year = Number(year.dataset.year); render(); return; }
      const toggle = ev.target.closest('[data-toggle]');
      if (toggle) {
        const key = toggle.dataset.toggle;
        if (ui.open.has(key)) ui.open.delete(key); else ui.open.add(key);
        render();
        return;
      }
      const active = TABS.find(t => t.code === ui.tab);
      if (!active?.handle) return;
      try {
        if (active.handle(ev, context())) render();
      } catch (e) {
        console.error(e);
        notice('danger', e.message);
      }
    });

    store.subscribe(ev => {
      if (ev.type === 'change') render();
      else if (ev.type === 'status') renderStatus(ev.status);
      else if (ev.type === 'conflict') {
        notice('warn', 'Этот раздел только что изменили в другой вкладке или на другом устройстве. '
          + 'Показаны свежие данные, ваша последняя правка в нём не сохранилась.');
      } else if (ev.type === 'error') {
        console.error(ev.error);
        notice('danger', 'Не удалось сохранить: ' + ev.error.message);
      }
    });

    window.addEventListener('beforeunload', ev => {
      if (!store.hasPending()) return;
      store.flush();
      ev.preventDefault();
      ev.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') store.flush();
    });

    render();
  }

  return { start, render, notice };
}
