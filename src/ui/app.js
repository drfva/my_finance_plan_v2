/* ---------------------------------------------------------------------
   app.js — оболочка: шапка, вкладки, выбор года и общий расчёт.

   Расчёт обновляется при изменении данных плана и передаётся
   вкладкам. Правка данных идёт через edit.js, поэтому вкладки — это почти
   только разметка.
--------------------------------------------------------------------- */

import { esc, byId } from './dom.js';
import { attachEditing } from './edit.js';
import { freezePeriods, snapshotGoalCompletion } from '../engine/allocation.js';
import { classifyIncomePeriods } from '../engine/income.js';
import { createPlanCache } from './plan-cache.js';
import { createFxUpdater } from '../core/fx-rates.js';
import { createSecurity } from '../core/security.js';
import { tourNeeded, tourPanel, tourHandle } from './tour.js';
import { lateYears } from './alerts.js';
import { syncGenerated, normalizeGoalPriorities } from '../engine/savings.js';
import { familyToday } from '../engine/family.js';
import { applyTheme, nextTheme } from '../core/theme.js';
import { themeButton, updateThemeButton } from './theme-switch.js';
import { scrollToPending } from './navigation.js';
import {mobileNavigation,syncMobileNavigation,attachMobileNavigation} from './mobile-navigation.js';
import {adaptTables} from './responsive-tables.js';

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
import * as sick from './sick.js';
import * as settings from './settings.js';
import * as ledger from './ledger.js';
import { attachSettings } from './settings.js';
import { FAMILY_TABS, invitationCard, handle as handleFamily, handleChange as familyChange } from './family.js';

const TABS = [dashboard, periods, categories, facts, goals, gifts, reserves, credits, installments, vacations, sick, settings];
/* Вкладки без кнопки в шапке: открываются из других разделов (кнопкой в карточке) */
const HIDDEN = [ledger];
const ALL_TABS = [...TABS, ...HIDDEN];

const STATUS_TEXT = { pending: 'Есть изменения', saving: 'Сохранение…', saved: 'Сохранено', error: 'Ошибка сохранения' };

export const ROLE_TITLES = {
  owner: 'владелец',
  editor: 'редактор',
  viewer: 'читатель — только просмотр',
};

/* Годы плана: и те, где уже есть выплаты, и те, где пока задан только график.
   Пока нет ничего — предлагаем следующий календарный год. */
export function planYears(state, today) {
  if (state.account?.plan_kind === 'family') return [...new Set([
    Number(today.slice(0,4)),
    ...(state.family?.contributions ?? []).map(c => Number(c.pay_date?.slice(0,4))),
    ...(state.family?.budget?.months ?? []).map(m => Number(m.month.slice(0,4))),
    ...(state.family?.monthly_expenses ?? []).map(m => Number(m.month.slice(0,4))),
    ...(state.family?.expense_facts ?? []).map(m => Number(m.month.slice(0,4))),
  ])].filter(y=>Number.isFinite(y)&&y>0).sort((a,b)=>a-b);
  const inc = state.income ?? {};
  const list = [...new Set([
    ...(inc.periods ?? []).map(p => Number(p.year)),
    ...(inc.plan_years ?? []).map(y => Number(y.year)),
    ...(inc.payout_slots ?? []).map(s => Number(s.year)),
  ])].filter(Number.isFinite).sort((a, b) => a - b);
  return list.length ? list : [Number(today.slice(0, 4)) + 1];
}

/* Показываем до трёх соседних годов. На краю списка дополняем окно
   с другой стороны; остальные годы доступны в раскрывающихся списках. */
export function yearWindow(list, current) {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const i = Math.max(0, sorted.indexOf(current));
  const from = Math.min(Math.max(0, i - 1), Math.max(0, sorted.length - 3));
  return {
    shown: sorted.slice(from, from + 3),
    past: sorted.slice(0, from),
    future: sorted.slice(from + 3),
  };
}

export function createApp({ store, env = 'prod', client = null, onSignOut }) {
  const ui = { tab: null, year: null, goal: null, open: new Set(), draft: {
    familyInvite: new URLSearchParams(location.search).get('family_invite') || undefined,
  }, notice: null };
  const security = client ? createSecurity(client, () => render()) : null;
  let lastSync = '';
  let syncingSick = false;
  let rendered = 0;
  let pendingServerRender = false;
  let lateCache;
  const plan = createPlanCache();
  const fxUpdater = createFxUpdater(store);
  const availableTabs = ctx => ctx.state.account?.plan_kind === 'family' ? FAMILY_TABS : ALL_TABS;

  function context() {
    const state = store.state;
    const c = store.config();
    const { fmt: f, income, sim, today } = plan(state, c);
    const list = planYears(state, today);
    const currentTab = availableTabs({ state }).find(t => t.code === (ui.tab ?? c.get('start_tab')));
    const yearOptions = currentTab?.yearOptions?.({ state, years: list }) ?? list;
    if (!yearOptions.includes(ui.year)) ui.year = yearOptions.includes(Number(f.todayISO().slice(0, 4))) ? Number(f.todayISO().slice(0, 4)) : yearOptions[0];
    return { store, state, cfg: c, fmt: f, income, sim, ui, year: ui.year, years: list, yearOptions,
      today: state.account?.plan_kind === 'family' ? familyToday() : f.todayISO(), canEdit: c.canEdit, security, onSignOut, notice };
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
      return true;
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
    if (ctx.state.current_fx?.loading || ctx.sim.warnings.some(w => w.code === 'no_fx_rate')) return false;
    const ids = ctx.sim.rows.filter(r => !r.period.locked && !r.income.formula?.error && !r.income.formula?.overpaid && !r.income.sick?.pendingTax && !r.income.sickPendingTax
      && (!r.familyContribution?.member_id || r.familyContribution.posted) && r.period.pay_date < ctx.today).map(r => r.period.id);
    if (!ids.length) return false;
    const patch = freezePeriods(ctx.state, ctx.sim, ids, ctx.fmt.round);
    store.update('income', d => { d.periods = patch.periods; });
    store.update('savings', d => { d.savings_period_overrides = patch.savings_period_overrides; });
    store.update('debts', d => { d.credit_payment_overrides = patch.credit_payment_overrides; });
    return true;
  }

  function tabsHtml(ctx, late) {
    const tabs = ctx.state.account?.plan_kind === 'family' ? FAMILY_TABS : TABS;
    return tabs.map(t => `<button class="${t.code === ui.tab ? 'active' : ''}" data-tab="${t.code}">${esc(t.title(ctx))}${
      late[t.code]?.size ? '<i class="late-dot" title="Есть сроки, в которые план не укладывается"></i>' : ''}</button>`).join('');
  }

  function shell(ctx, body) {
    const tab = availableTabs(ctx).find(t => t.code === ui.tab);
    if (lateCache?.sim !== ctx.sim) lateCache = { sim: ctx.sim, value: lateYears(ctx) };
    const late = lateCache.value;
    const lateHere = late[ui.tab] ?? new Set();
    const yearBtn = y => `<button class="${y === ctx.year ? 'active' : ''}" data-year="${y}">${y}${
      lateHere.has(y) ? '<i class="late-dot"></i>' : ''}</button>`;
    let yearBtns = '';
    if (ctx.yearOptions.length > 1 && tab?.hasYears) {
      const win = yearWindow(ctx.yearOptions, ctx.year);
      const more = (key, list, label) => (list.length ? `
        <button class="${ui.open.has(key) ? 'active' : ''}" data-toggle="${key}">${label} (${list.length})${
          list.some(y => lateHere.has(y)) ? '<i class="late-dot"></i>' : ''}</button>
        ${ui.open.has(key) ? list.map(yearBtn).join('') : ''}` : '');
      yearBtns = `<div class="month-tabs" style="margin:0;">
        ${more('years-past', win.past, 'Предыдущие годы')}
        ${win.shown.map(yearBtn).join('')}
        ${more('years-next', win.future, 'Будущие годы')}
      </div>`;
    }
    const tabActions = tab?.actions ? tab.actions(ctx) : '';
    const topRow = yearBtns || tabActions
      ? `<div class="row between wrap" style="gap:10px;margin-bottom:14px;">${yearBtns || '<span></span>'}
          <div class="row wrap" style="gap:8px;">${tabActions}</div></div>`
      : '';
    return `
      <div class="topbar"><div class="topbar-inner">
        ${mobileNavigation(tabsHtml(ctx,late),{planTitle:ctx.state.account?.title,role:ROLE_TITLES[ctx.state.account?.role]??''})}
        <div class="brand"><h1 style="font-size:19px;">${esc(ctx.state.account?.title || 'Финансы')}</h1>
          <span class="mobile-current-section">${esc(tab?.title(ctx)??'Обзор')}</span>
          ${env === 'dev' ? '<span class="pill danger" style="font-size:11px;">ТЕСТ</span>' : ''}
          ${ctx.canEdit ? '' : '<span class="pill" style="font-size:11px;">только просмотр</span>'}
          ${ctx.years.length ? `<span class="pill" style="font-size:11px;">${esc(ROLE_TITLES[ctx.state.account?.role] ?? ctx.state.account?.role ?? '')}</span>` : ''}
        </div>
        <div class="topbar-right">
          <span class="savebadge" id="save-badge"></span>
          <span class="today-date">Сегодня <b>${esc(ctx.fmt.date(ctx.today, 'weekday'))}</b></span>
          <button class="ghost small" id="sign-out">Выйти</button>
          <a class="help-link" href="help/" target="_blank" rel="noopener" aria-label="Открыть руководство пользователя" title="Руководство пользователя (в новой вкладке)">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 .5c0 1.7-2.5 2-2.5 4"/><path d="M12 16.5h.01"/></svg>
          </a>
          ${themeButton()}
        </div>
      </div>
      <nav class="tabs">${tabsHtml(ctx, late)}</nav>
      </div>
      <main>
        ${ui.notice ? `<div class="info-box row between" style="background:var(--${ui.notice.kind}-soft);color:var(--${ui.notice.kind});">
          <span>${esc(ui.notice.text)}</span><button class="ghost small" id="notice-close">×</button></div>` : ''}
        ${topRow}
        ${body}
      </main>
      ${ctx.state.account?.plan_kind !== 'family' && !ui.draft.familyInvite && tourNeeded(ctx) ? tourPanel(ctx) : ''}`;
  }

  function render() {
    if (syncingSick) return;
    if (fxUpdater.ensure()) return;
    const ctx = context();
    if (ctx.state.account?.plan_kind !== 'family') {
    if (ctx.canEdit && JSON.stringify(ctx.state.income?.periods ?? []) !== JSON.stringify(ctx.income.preparedPeriods)) {
      const next = ctx.income.preparedPeriods;
      const ids = new Set(next.map(p => p.id));
      const removed = new Set((ctx.state.income?.periods ?? []).filter(p => !ids.has(p.id)).map(p => p.id));
      syncingSick = true;
      try {
        store.update('income', d => { d.periods = next; });
        for (const [domain, table] of [['expenses', 'expense_period_overrides'], ['savings', 'savings_period_overrides'], ['debts', 'credit_payment_overrides']]) {
          if ((store.state[domain]?.[table] ?? []).some(r => removed.has(r.period_id))) {
            store.update(domain, d => { d[table] = d[table].filter(r => !removed.has(r.period_id)); });
          }
        }
      } finally { syncingSick = false; }
      render();
      return;
    }
    const unclassified = ctx.canEdit ? classifyIncomePeriods(ctx.income) : [];
    if (unclassified.length) {
      const flags = new Map(unclassified.map(p => [p.id, p.manual]));
      store.update('income', d => {
        for (const p of d.periods ?? []) if (flags.has(p.id)) p.income_manual = flags.get(p.id);
      });
      return;
    }
    if (ensureGiftsGoal(ctx)) return;  // состояние изменилось — отрисовка придёт событием
    if (syncGeneratedRows(ctx)) return;
    if (freezePast(ctx)) return;      // состояние изменилось — отрисовка придёт событием
    // Старые закрытые цели ещё не содержат снимка: закрепляем доступную историю
    // на сегодня. Первоначальная дата их закрытия в прежней модели не хранилась.
    const missing = ctx.canEdit ? (ctx.state.savings?.goals ?? [])
      .filter(g => g.completed && !g.completion_snapshot) : [];
    const normalized = normalizeGoalPriorities(ctx.state.savings?.goals ?? []);
    const prioritiesChanged = ctx.canEdit && normalized.some((g, i) => g.priority !== ctx.state.savings.goals[i].priority);
    if (missing.length || prioritiesChanged) {
      const snapshots = new Map(missing.map(g => [g.id, snapshotGoalCompletion(ctx.sim, g, ctx.today)]));
      store.update('savings', d => {
        d.goals = normalized;
        for (const g of d.goals) if (snapshots.has(g.id)) g.completion_snapshot = snapshots.get(g.id);
      });
      return;
    }
    }
    if (!ui.tab || !availableTabs(ctx).some(t => t.code === ui.tab)) {
      const start = ctx.cfg.get('start_tab');
      ui.tab = availableTabs(ctx).some(t => t.code === start) ? start : 'dashboard';
    }
    const tab = availableTabs(ctx).find(t => t.code === ui.tab);
    let body;
    try {
      body = tab.render(ctx);
    } catch (e) {
      console.error(e);
      body = `<div class="card"><h2>Не получилось показать вкладку</h2><p class="muted">${esc(e.message)}</p></div>`;
    }
    store.endEditing?.();
    pendingServerRender = false;
    rendered++;
    byId('root').innerHTML = shell(ctx, invitationCard(ctx) + body);
    adaptTables(byId('root'));
    syncMobileNavigation(byId('root'),ui);
    const deletion=byId('root').querySelector('.account-delete-dialog');
    (deletion?.querySelector('[data-account-delete-word]')??deletion?.querySelector('select:not(:disabled)')??deletion?.querySelector('button:not(:disabled)'))?.focus({preventScroll:true});
    byId('sign-out').addEventListener('click', async () => { await store.flush(); onSignOut(); });
    const close = byId('notice-close');
    if (close) close.addEventListener('click', () => { ui.notice = null; render(); });
    renderStatus(store.status());
    // активная вкладка всегда видна: список вкладок прокручивается по горизонтали
    document.querySelector('nav.tabs button.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    scrollToPending(byId('root'), ui);

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
    attachSettings(root, store, context, render);
    attachMobileNavigation(root,ui,render);

    // черновики форм живут в памяти вкладки и не перерисовывают экран
    root.addEventListener('change', ev => {
      const familyChanged=familyChange(ev, context());
      if (familyChanged) { if(familyChanged==='render')render();return; }
      if (ui.tab === categories.code && categories.handleChange(ev, context())) return;
      const el = ev.target.closest('[data-draft]');
      if (!el) return;
      const draft = ui.draft[ui.tab] ?? (ui.draft[ui.tab] = {});
      draft[el.dataset.draft] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.hasAttribute('data-family-reveal')) render();
    });

    root.addEventListener('click', ev => {
      const theme=ev.target.closest('[data-theme-cycle]');
      if(theme){updateThemeButton(theme,applyTheme(nextTheme(theme.dataset.theme)));return;}
      const tab = ev.target.closest('[data-tab]');
      if (tab) { ui.tab = tab.dataset.tab; ui.open.clear(); render(); return; }
      const year = ev.target.closest('[data-year]');
      if (year) { ui.year = Number(year.dataset.year); render(); return; }
      const toggle = ev.target.closest('[data-toggle]');
      if (toggle) {
        const key = toggle.dataset.toggle;
        const keepCategoryFocus = toggle.classList.contains('category-head') && document.activeElement === toggle;
        const revealPast = key === 'past' && !ui.open.has(key);
        if (ui.open.has(key)) ui.open.delete(key); else ui.open.add(key);
        render();
        if (keepCategoryFocus) [...root.querySelectorAll('.category-head')]
          .find(el => el.dataset.toggle === key)?.focus({ preventScroll: true });
        if (revealPast) {
          const anchor = root.querySelector('[data-past-anchor]');
          anchor?.focus({ preventScroll: true });
          anchor?.scrollIntoView({ block: 'start', behavior: 'instant' });
        }
        return;
      }
      // Фокус, календарь и ввод текста сами по себе не являются командами.
      if (!ev.target.closest('button') || ev.target.closest('[data-add],[data-del],[data-clear-date]')) return;
      if (tourHandle(ev, context())) { render(); return; }
      if (ev.target.closest('[data-family-action]')) { handleFamily(ev,context()); render(); return; }

      const active = availableTabs(context()).find(t => t.code === ui.tab);
      if (!active?.handle) return;
      try {
        const before = rendered;
        if (active.handle(ev, context()) && rendered === before) render();
      } catch (e) {
        console.error(e);
        notice('danger', e.message);
      }
    });

    store.subscribe(ev => {
      // открыли другой план: генератор должен пересобрать этапы заново
      if (ev.type === 'loaded') {
        lastSync = ''; ui.tab = null; ui.year = null; ui.goal = null; ui.open.clear();
        ui.scrollTarget = null;
        ui.draft = { familyInvite: ui.draft.familyInvite };
        const address = new URL(location.href); address.searchParams.set('plan',store.state.account.id);
        window.history.replaceState(null,'',address); render(); return;
      }
      if (ev.type === 'change') {
        const focused = document.activeElement;
        if (ev.fromServer && root.contains(focused) && focused.matches('input,select,textarea')) pendingServerRender = true;
        else render();
      }
      else if (ev.type === 'status') renderStatus(ev.status);
      else if (ev.type === 'conflict') {
        notice('warn', 'Этот раздел только что изменили в другой вкладке или на другом устройстве. '
          + 'Показаны свежие данные, ваша последняя правка в нём не сохранилась.');
      } else if (ev.type === 'error') {
        console.error(ev.error);
        notice('danger', 'Не удалось сохранить: ' + ev.error.message);
      }
    });

    root.addEventListener('focusout', () => {
      if (!pendingServerRender) return;
      queueMicrotask(() => {
        const focused = document.activeElement;
        if (pendingServerRender && !(root.contains(focused) && focused.matches('input,select,textarea'))) render();
      });
    });

    window.addEventListener('beforeunload', ev => {
      if (!store.hasPending()) return;
      store.flush();
      ev.preventDefault();
      ev.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') store.flush();
      else render();
    });
    window.addEventListener('focus', () => render());

    render();
  }

  return { start, render, notice };
}
