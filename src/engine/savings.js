/* ---------------------------------------------------------------------
   savings.js — цели, этапы, циклы, подарки, прогресс.

   Этапы цели (goal_milestones) — ПРИРОСТЫ: каждый этап набирается с нуля после
   закрытия предыдущего, общая сумма цели = сумма этапов. Этапы идут по сроку,
   без срока — в конце. У цели без этапов один этап: target_amount к deadline.
   Закрытый этап засчитан навсегда, даже если деньги потом потрачены.

   Траты и пополнения (goal_transactions):
     spend, transfer_out     — уменьшают копилку;
     deposit, transfer_in    — пополняют и засчитываются в этапы.
   Трата сначала тратит деньги закрытых этапов, если она плановая для них (не
   раньше срока этапа или не более чем за planned_spend_window_days до него), потом
   съедает прогресс текущего этапа, и только потом откатывает закрытые этапы, чьи
   деньги ушли раньше срока.

   Циклы (goal_cycles) и праздники (gift_events) — шаблоны: syncGenerated
   разворачивает их в этапы и траты с source = 'cycle' / 'gift'. Строку, которую
   пользователь изменил (user_edited), генератор больше не трогает; удалённые
   вхождения цикла лежат в goal_cycle_skips и не возвращаются.

   Суммы целей — в валюте цели. В базовую валюту их переводит allocation.js.
--------------------------------------------------------------------- */

import { addDays, addMonths, parts, clampDay, daysInclusive } from './dates.js';

const byDeadline = (a, b) => {
  const ka = a.deadline || '9999-99-99';
  const kb = b.deadline || '9999-99-99';
  return ka < kb ? -1 : ka > kb ? 1 : (a.sort_order ?? 0) - (b.sort_order ?? 0);
};

/* Этапы цели по порядку набора */
export function milestonesOf(goal, milestones) {
  const own = milestones.filter(m => m.goal_id === goal.id).sort(byDeadline);
  if (own.length) return own.map(m => ({ ...m, target: Number(m.target) || 0 }));
  return [{ id: '_main', goal_id: goal.id, title: goal.title, target: Number(goal.target_amount) || 0, deadline: goal.deadline || null }];
}

export const goalTotal = (goal, milestones) => milestonesOf(goal, milestones).reduce((s, m) => s + m.target, 0);

const isOutflow = kind => kind === 'spend' || kind === 'transfer_out';

/* ------------------------------------------------------------------ учёт этапов */

export function createTracker({ goals, milestones, plannedWindowDays = 45 }) {
  const ms = new Map();
  const balance = new Map();
  const idx = new Map();
  const phaseSaved = new Map();
  const dates = new Map();       // goal → [дата закрытия этапа | 'pre' | null]
  const pool = new Map();        // деньги закрытых этапов, ещё не потраченные

  function close(gid, i, date) {
    dates.get(gid)[i] = date;
    pool.get(gid).push({ idx: i, deadline: ms.get(gid)[i].deadline || '', left: ms.get(gid)[i].target });
  }

  function advance(gid, date) {
    const list = ms.get(gid);
    while (idx.get(gid) < list.length && phaseSaved.get(gid) >= list[idx.get(gid)].target - 1e-9) {
      phaseSaved.set(gid, phaseSaved.get(gid) - list[idx.get(gid)].target);
      close(gid, idx.get(gid), date);
      idx.set(gid, idx.get(gid) + 1);
    }
  }

  for (const g of goals) {
    const list = milestonesOf(g, milestones);
    const start = Number(g.starting_balance) || 0;
    ms.set(g.id, list);
    balance.set(g.id, start);
    idx.set(g.id, 0);
    phaseSaved.set(g.id, start);
    dates.set(g.id, list.map(() => null));
    pool.set(g.id, []);
    advance(g.id, 'pre');
  }

  const isPlanned = (deadline, date) => !deadline || date >= deadline
    || daysInclusive(date, deadline) - 1 <= plannedWindowDays;

  function deposit(gid, amount, date) {
    if (!amount || !ms.has(gid)) return;
    balance.set(gid, balance.get(gid) + amount);
    phaseSaved.set(gid, phaseSaved.get(gid) + amount);
    advance(gid, date);
  }

  function withdraw(gid, amount, date) {
    if (!ms.has(gid)) return;
    balance.set(gid, balance.get(gid) - amount);
    const list = ms.get(gid);
    const closed = pool.get(gid);
    let left = amount;
    // 1. плановая трата: деньги закрытых этапов, чей срок подошёл
    for (const c of closed) {
      if (left <= 0.0001) break;
      if (c.left <= 0 || !isPlanned(c.deadline, date)) continue;
      const take = Math.min(left, c.left);
      c.left -= take;
      left -= take;
    }
    // 2. прогресс текущего этапа
    const take = Math.min(left, phaseSaved.get(gid));
    phaseSaved.set(gid, phaseSaved.get(gid) - take);
    left -= take;
    // 3. откат закрытых этапов, чьи деньги ушли раньше срока
    while (left > 0.0001 && idx.get(gid) > 0) {
      const prevIdx = idx.get(gid) - 1;
      const prev = list[prevIdx];
      if (isPlanned(prev.deadline, date)) break;
      idx.set(gid, prevIdx);
      dates.get(gid)[prevIdx] = null;
      const at = closed.findLastIndex(c => c.idx === prevIdx);
      if (at >= 0) closed.splice(at, 1);
      const back = Math.min(left, prev.target);
      phaseSaved.set(gid, Math.max(0, prev.target - back));
      left -= back;
    }
  }

  function apply(tx) {
    const amount = Math.abs(Number(tx.amount) || 0);
    if (isOutflow(tx.kind)) withdraw(tx.goal_id, amount, tx.date);
    else deposit(tx.goal_id, amount, tx.date);
  }

  return {
    milestones: gid => ms.get(gid) ?? [],
    phase: gid => ({ idx: idx.get(gid) ?? 0, saved: phaseSaved.get(gid) ?? 0 }),
    balance: gid => balance.get(gid) ?? 0,
    deposit, withdraw, apply,
    snapshot() {
      const out = { balances: {}, phase: {} };
      for (const gid of ms.keys()) {
        out.balances[gid] = balance.get(gid);
        out.phase[gid] = { idx: idx.get(gid), saved: phaseSaved.get(gid) };
      }
      return out;
    },
    milestoneDates: () => Object.fromEntries([...dates].map(([k, v]) => [k, [...v]])),
  };
}

/* Сколько засчитано в цель по снимку этапов: закрытые этапы + прогресс текущего */
export function progressOf(list, phase) {
  let sum = 0;
  for (let i = 0; i < phase.idx && i < list.length; i++) sum += list[i].target;
  if (phase.idx < list.length) sum += phase.saved;
  return sum;
}

/* ------------------------------------------------------------------ генераторы */

/* Даты вхождений цикла до даты until (включительно) */
export function cycleDates(cycle, until, units = []) {
  if (!cycle.start_date) return [];
  const every = Math.max(1, Number(cycle.every_n) || 1);
  const ref = units.find(u => u.code === cycle.period_unit);
  const limit = cycle.repeats ? Number(cycle.repeats) : Infinity;
  const out = [];
  for (let k = 0; k < limit && k < 1000; k++) {
    let d;
    if (cycle.period_unit === 'day' || cycle.period_unit === 'week' || ref?.days) {
      d = addDays(cycle.start_date, k * every * (ref?.days ?? (cycle.period_unit === 'week' ? 7 : 1)));
    } else {
      const { y, m, d: day } = parts(cycle.start_date);
      const t = addMonths(y, m, k * every * (cycle.period_unit === 'year' ? 12 : 1));
      d = clampDay(t.y, t.m, day);
    }
    if (until && d > until) break;
    out.push(d);
  }
  return out;
}

/* Сумма праздника на год: за этот год, иначе за ближайший прошлый, иначе за ближайший будущий */
export function giftAmountForYear(eventId, amounts, year) {
  const own = amounts.filter(a => a.event_id === eventId).sort((a, b) => a.year - b.year);
  let found = null;
  for (const a of own) { if (a.year <= year) found = a; }
  return Number((found ?? own[0])?.amount) || 0;
}

/* Развернуть циклы и праздники в этапы и траты.
   Возвращает новые goal_milestones и goal_transactions и признак changed. */
export function syncGenerated({ savings = {}, gifts = {}, until, years = [], today, units = [], goalKinds = {} }) {
  const goals = savings.goals ?? [];
  const goalIds = new Set(goals.map(g => g.id));
  const giftsGoal = goals.find(g => (goalKinds[g.kind_code] ?? g.kind_code) === 'gifts' || g.kind_code === 'gifts');
  const skips = new Set((savings.goal_cycle_skips ?? []).map(s => `${s.cycle_id}|${s.occurrence_key}`));
  const wantMs = [];
  const wantTx = [];
  // вхождение, которое пользователь правил (этап или его трату), генератор не трогает целиком
  const edited = new Set([
    ...(savings.goal_milestones ?? []).filter(m => m.user_edited).map(m => m.id),
    ...(savings.goal_transactions ?? []).filter(t => t.user_edited && t.milestone_id).map(t => t.milestone_id),
  ]);

  for (const c of savings.goal_cycles ?? []) {
    if (c.enabled === false || !goalIds.has(c.goal_id)) continue;
    const goal = goals.find(g => g.id === c.goal_id);
    for (const date of cycleDates(c, until, units)) {
      if (skips.has(`${c.id}|${date}`)) continue;
      const msId = `cyc:${c.id}:${date}`;
      if (edited.has(msId)) continue;
      wantMs.push({
        id: msId, goal_id: c.goal_id, title: c.title || goal.title, target: Number(c.amount) || 0, deadline: date,
        source: 'cycle', source_ref: c.id, occurrence_key: date, user_edited: false, sort_order: 0,
      });
      if (c.auto_spend !== false) {
        wantTx.push({
          id: `${msId}:spend`, goal_id: c.goal_id, date, amount: Number(c.amount) || 0, kind: 'spend',
          title: c.title || goal.title, counterparty_id: null, milestone_id: msId,
          source: 'cycle', occurrence_key: date, user_edited: false,
        });
      }
    }
  }

  const amounts = gifts.gift_event_amounts ?? [];
  for (const e of gifts.gift_events ?? []) {
    const goalId = e.goal_id && goalIds.has(e.goal_id) ? e.goal_id : giftsGoal?.id;
    if (!goalId || !e.day || !e.month) continue;
    const ys = e.repeat_kind === 'once' ? [Number(e.base_year)].filter(Boolean) : years;
    for (const y of ys) {
      const date = clampDay(y, e.month, e.day);
      // повторяющийся праздник задним числом не планируем
      if (e.repeat_kind !== 'once' && today && date < today) continue;
      const amount = giftAmountForYear(e.id, amounts, y);
      const title = `${e.title || 'Праздник'} ${y}`;
      const msId = `gift:${e.id}:${y}`;
      if (edited.has(msId)) continue;
      wantMs.push({
        id: msId, goal_id: goalId, title, target: amount, deadline: date,
        source: 'gift', source_ref: e.id, occurrence_key: String(y), user_edited: false, sort_order: 0,
      });
      wantTx.push({
        id: `${msId}:spend`, goal_id: goalId, date, amount, kind: 'spend', title, counterparty_id: null,
        milestone_id: msId, source: 'gift', occurrence_key: String(y), user_edited: false,
      });
    }
  }

  function merge(existing, wanted) {
    const keep = existing.filter(r => r.source === 'manual' || !r.source || r.user_edited);
    const kept = new Set(keep.map(r => r.id));
    const out = [...keep, ...wanted.filter(r => !kept.has(r.id))];
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  const goal_milestones = merge(savings.goal_milestones ?? [], wantMs);
  const goal_transactions = merge(savings.goal_transactions ?? [], wantTx);
  // порядок ключей в строках из базы другой, поэтому сравниваем с отсортированными ключами
  const stable = r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));
  const norm = list => [...list].map(stable).sort().join('\n');
  const changed = norm(goal_milestones) !== norm(savings.goal_milestones ?? [])
    || norm(goal_transactions) !== norm(savings.goal_transactions ?? []);
  return { goal_milestones, goal_transactions, changed };
}
