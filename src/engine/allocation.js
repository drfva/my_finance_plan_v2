/* ---------------------------------------------------------------------
   allocation.js — конвейер распределения выплат.

     const sim = simulate(store.state, store.config());
     sim.rows            → по каждой выплате: доход, этапы, суммы в цели, погашения, остаток
     sim.byId            → то же по id выплаты
     sim.milestoneDates  → когда закрывается каждый этап каждой цели
     sim.milestoneFunded → сколько денег закрытого этапа ещё лежит в копилке
     sim.cardCycles      → льготные периоды карт и даты их закрытия
     sim.monthChecks     → процентные категории: собрано за месяц против плана
     sim.warnings        → чего не хватает для расчёта (курса, выплат и т. п.)

   Выплаты идут по дате. В каждой, до распределения, применяются траты и
   пополнения копилок и операции по картам с датой не позже даты выплаты.
   Дальше этапы из allocation_rules по приоритету, выключенные пропускаются:

     categories   — план расходов (expenses.js). params.percent_base: 'net'
                    (по умолчанию, от дохода на руки) или 'gross' (от gross по окладу);
     installments — платежи рассрочек этой выплаты;
     credits      — по каждой карте, у кого срок ближе — первой: столько, чтобы
                    успеть до конца льготного периода с учётом будущих выплат;
     gifts, buckets, reserves — темп для целей своего типа (ref_goal_kinds).

   Темп подушки (pace_amount) откладывается раньше копилок: если у подушки задан
   темп, эта сумма уходит в неё из свободных денег до этапа buckets. Старая версия
   так не делала — для сверки с ней есть опция paceFirst: false.

   После этапов — доливка остатка по целям: по одному этапу за раз, у кого срок
   ближе; цели без срока — по приоритету; подушки — отдельной группой на своём
   месте в порядке этапов. Затем, если у этапа credits не выключено
   params.early_repayment, остаток идёт в досрочное погашение карт.

   Зафиксированная выплата (locked) или выплата с ручными суммами в копилки
   (savings_period_overrides) автоматически в цели не распределяется: в цели идут
   только ручные суммы. У зафиксированной нет и автоматических погашений карт.

   Все суммы конвейера — в базовой валюте. Суммы целей и карт в другой валюте
   переводятся по курсу на дату выплаты (fx.js).
--------------------------------------------------------------------- */

import { computeIncome } from './income.js';
import { planExpenses } from './expenses.js';
import { installmentsByPeriod, newCardState, sortedCardOps, cardApplyOp, cardApplyPayment } from './debts.js';
import { createTracker, milestonesOf, progressOf } from './savings.js';
import { createFx } from './fx.js';

const SAVINGS_STAGES = ['gifts', 'buckets', 'reserves'];

export function simulate(state, cfg, { income = null, round = Math.round, paceFirst = true } = {}) {
  const inc = income ?? computeIncome(state, cfg, { round });
  const periods = inc.periods.map(r => r.period);
  const warnings = [...inc.warnings];
  const warned = new Set();
  const warnOnce = (code, extra) => {
    const key = code + JSON.stringify(extra);
    if (!warned.has(key)) { warned.add(key); warnings.push({ code, ...extra }); }
  };

  const fx = createFx(state.settings?.fx_rates ?? [], cfg.get('base_currency'));
  const stages = cfg.stages().filter(s => s.enabled);
  const stage = code => stages.find(s => s.code === code) ?? null;

  /* какой этап отвечает за цель: по справочнику типов целей */
  const kindStage = new Map(cfg.list('goal_kinds').map(k => [k.code, k.stage_code]));
  const stageOfGoal = g => kindStage.get(g.kind_code) ?? 'buckets';

  /* ---------------------------------------------------------- расходы и рассрочки */
  const exp = state.expenses ?? {};
  const percentBase = stage('categories')?.params?.percent_base === 'gross'
    ? p => inc.byId.get(p.id)?.formula?.gross ?? 0
    : p => inc.byId.get(p.id)?.total ?? 0;
  const expenses = planExpenses({
    categories: exp.expense_categories ?? [],
    items: exp.expense_items ?? [],
    overrides: exp.expense_period_overrides ?? [],
    periods,
    slots: state.income?.payout_slots ?? [],
    incomeById: new Map(inc.periods.map(r => [r.period.id, r.total])),
    percentBase,
    round,
  });

  const debts = state.debts ?? {};
  const inst = installmentsByPeriod(debts.installments ?? [], debts.installment_payments ?? [], periods);
  if (inst.outside.length) warnOnce('installments_before_plan', { count: inst.outside.length });

  /* ---------------------------------------------------------- накопления */
  const sv = state.savings ?? {};
  const goals = sv.goals ?? [];
  const milestones = sv.goal_milestones ?? [];
  const tracker = createTracker({ goals, milestones });
  const initialPhase = tracker.snapshot();
  const txs = (sv.goal_transactions ?? []).filter(t => t.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let txPtr = 0;
  const applyTxUpTo = date => {
    while (txPtr < txs.length && (date === null || txs[txPtr].date <= date)) tracker.apply(txs[txPtr++]);
  };

  const savingsOv = new Map();
  for (const o of sv.savings_period_overrides ?? []) {
    if (!savingsOv.has(o.period_id)) savingsOv.set(o.period_id, new Map());
    savingsOv.get(o.period_id).set(o.goal_id, Number(o.amount) || 0);
  }

  /* ---------------------------------------------------------- карты */
  const cards = debts.credit_cards ?? [];
  const cardState = new Map(cards.map(c => [c.id, newCardState()]));
  const cardCycles = new Map(cards.map(c => [c.id, []]));
  const cardOps = new Map(cards.map(c => [c.id, sortedCardOps(debts.credit_card_ops ?? [], c.id)]));
  const cardPtr = new Map(cards.map(c => [c.id, 0]));
  const applyCardOpsUpTo = date => {
    for (const c of cards) {
      const ops = cardOps.get(c.id);
      while (cardPtr.get(c.id) < ops.length && (date === null || ops[cardPtr.get(c.id)].op_date <= date)) {
        cardApplyOp(cardState.get(c.id), c, ops[cardPtr.get(c.id)], cardCycles.get(c.id));
        cardPtr.set(c.id, cardPtr.get(c.id) + 1);
      }
    }
  };
  const cardOv = new Map();
  for (const o of debts.credit_payment_overrides ?? []) {
    if (!cardOv.has(o.period_id)) cardOv.set(o.period_id, new Map());
    cardOv.get(o.period_id).set(o.card_id, Number(o.amount) || 0);
  }

  /* Что останется от будущей выплаты после расходов, рассрочек и уже закреплённых
     сумм в копилки — для прогноза, успеет ли карта закрыться в срок */
  const baseFree = new Map();
  for (const r of inc.periods) {
    const p = r.period;
    const ov = savingsOv.get(p.id);
    const committed = (p.locked || ov?.size) ? [...(ov?.values() ?? [])].reduce((s, x) => s + x, 0) : 0;
    const instTotal = (inst.byPeriod.get(p.id) ?? []).reduce((s, x) => s + x.amount, 0);
    baseFree.set(p.id, r.total - expenses.byPeriod.get(p.id).total - instTotal - committed);
  }

  /* Обязательный платёж по карте из выплаты (в валюте карты):
     равными частями по выплатам до срока, но не меньше, чем нужно, чтобы остаток
     с будущими тратами покрыли следующие выплаты */
  function cardRequired(card, cs, p) {
    if (cs.debt <= 0.5 || !cs.deadline) return 0;
    if (cs.deadline < p.pay_date) return cs.debt;
    const left = periods.filter(q => q.pay_date >= p.pay_date && q.pay_date <= cs.deadline);
    if (left.length <= 1) return cs.debt;
    const even = cs.debt / left.length;
    let futureFreeBase = 0;
    for (const q of left) if (q.pay_date > p.pay_date) futureFreeBase += Math.max(0, baseFree.get(q.id));
    const futureFree = fx.fromBase(futureFreeBase, card.currency_code, p.pay_date) ?? 0;
    let futureNet = 0;
    for (const o of cardOps.get(card.id)) {
      if (o.op_date > p.pay_date && o.op_date <= cs.deadline) futureNet += (o.kind === 'payment' ? -1 : 1) * Math.abs(Number(o.amount) || 0);
    }
    return Math.min(cs.debt, Math.max(even, cs.debt + futureNet - futureFree));
  }

  /* ---------------------------------------------------------- требования целей */
  const periodsBetween = (from, to) => periods.filter(q => q.pay_date >= from && q.pay_date <= to).length;

  /* Сколько цель просит из выплаты сейчас (темп) и сколько ей не хватает до конца
     текущего этапа — в валюте цели; deadline — срок, к которому она спешит */
  function requirement(g, p) {
    const list = tracker.milestones(g.id);
    const { idx, saved } = tracker.phase(g.id);
    const reserve = stageOfGoal(g) === 'reserves';
    if (idx >= list.length) return { g, reserve, remaining: 0, per: 0, deadline: '' };
    const remaining = Math.max(0, list[idx].target - saved);

    if (reserve) {
      const stageDeadline = list[idx].deadline || '';
      let stagePer = 0;
      if (stageDeadline) {
        const n = periodsBetween(p.pay_date, stageDeadline);
        stagePer = n > 0 ? remaining / n : remaining;
      }
      const pace = Math.max(0, Number(g.pace_amount) || 0);
      return { g, reserve, remaining, per: Math.min(remaining, Math.max(pace, stagePer)), deadline: stageDeadline };
    }

    // этапы без срока впереди не прячут срок следующего: цель спешит к ближайшему сроку
    let look = idx;
    let need = remaining;
    let deadline = list[idx].deadline || '';
    while (!deadline && look + 1 < list.length) {
      look++;
      need += list[look].target;
      deadline = list[look].deadline || '';
    }
    const n = deadline ? periodsBetween(p.pay_date, deadline) : 0;
    const overdue = Boolean(deadline && deadline < p.pay_date && need > 0);
    const per = need <= 0 ? 0 : (deadline ? ((overdue || n <= 0) ? need : need / n) : 0);
    return { g, reserve, remaining, per, deadline };
  }

  /* Темп подушки: если у подушки задана сумма на выплату, она откладывается
     раньше копилок — на то он и темп. Возвращает, сколько ушло из выплаты. */
  function reservePaceStep(p, allocations, fixedGoals, remaining, deposit, given) {
    let spent = 0;
    const list = activeGoals('reserves')
      .filter(g => !fixedGoals.has(g.id) && (Number(g.pace_amount) || 0) > 0)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const g of list) {
      const left = remaining - spent;
      if (left <= 0.5) break;
      const req = requirement(g, p);
      const b = inBase(req, p.pay_date);
      if (!b) continue;
      const paceBase = fx.toBase(Number(g.pace_amount) || 0, g.currency_code, p.pay_date);
      if (paceBase === null) continue;
      const give = Math.min(paceBase, left, b.remainingBase);
      if (give > 0.0001 && deposit(g.id, give, p.pay_date, allocations)) {
        spent += give;
        given.set(g.id, (given.get(g.id) ?? 0) + give);
      }
    }
    return spent;
  }

  /* Перевод требования в базовую валюту; нет курса — цель пропускается */
  function inBase(req, date) {
    const code = req.g.currency_code;
    const per = fx.toBase(req.per, code, date);
    const remaining = fx.toBase(req.remaining, code, date);
    if (per === null || remaining === null) {
      warnOnce('no_fx_rate', { goal_id: req.g.id, currency: code });
      return null;
    }
    return { ...req, perBase: per, remainingBase: remaining };
  }

  function depositBase(gid, amountBase, date, allocations) {
    const g = goals.find(x => x.id === gid);
    const inGoal = g ? fx.fromBase(amountBase, g.currency_code, date) : null;
    if (inGoal === null) { warnOnce('no_fx_rate', { goal_id: gid, currency: g?.currency_code }); return false; }
    tracker.deposit(gid, inGoal, date);
    allocations[gid] = (allocations[gid] ?? 0) + amountBase;
    return true;
  }

  /* Очередь темпов внутри этапа (как в текущей версии): подарки — все вместе
     по приоритету; копилки — со сроком по сроку, без срока по приоритету;
     подушки — по сроку этапа, затем по приоритету */
  function paceOrder(list, stageCode) {
    return [...list].sort((a, b) => {
      if (stageCode !== 'gifts') {
        const ra = a.reserve ? 2 : (a.deadline ? 0 : 1);
        const rb = b.reserve ? 2 : (b.deadline ? 0 : 1);
        if (ra !== rb) return ra - rb;
        if (ra === 0 || ra === 2) {
          const ka = a.deadline || '9999-99-99';
          const kb = b.deadline || '9999-99-99';
          if (ka !== kb) return ka < kb ? -1 : 1;
        }
      }
      return (a.g.priority ?? 0) - (b.g.priority ?? 0);
    });
  }

  /* Группа доливки: подарки и копилки доливаются вместе (по сроку), подушки —
     своей группой. Место группы — по приоритету её этапов */
  const tierOf = code => {
    if (code === 'reserves') return stage('reserves')?.priority ?? Infinity;
    return Math.min(stage('gifts')?.priority ?? Infinity, stage('buckets')?.priority ?? Infinity);
  };

  function cascadeOrder(list) {
    return [...list].sort((a, b) => {
      const ta = tierOf(stageOfGoal(a.g));
      const tb = tierOf(stageOfGoal(b.g));
      if (ta !== tb) return ta - tb;
      const ra = a.reserve ? 2 : (a.deadline ? 0 : 1);
      const rb = b.reserve ? 2 : (b.deadline ? 0 : 1);
      if (ra !== rb) return ra - rb;
      if (ra === 0 || ra === 2) {
        const ka = a.deadline || '9999-99-99';
        const kb = b.deadline || '9999-99-99';
        if (ka !== kb) return ka < kb ? -1 : 1;
      }
      return (a.g.priority ?? 0) - (b.g.priority ?? 0);
    });
  }

  const activeGoals = code => goals.filter(g => !g.completed && stageOfGoal(g) === code && stage(code));

  /* ---------------------------------------------------------- проход по выплатам */
  const rows = [];
  for (const r of inc.periods) {
    const p = r.period;
    applyTxUpTo(p.pay_date);
    applyCardOpsUpTo(p.pay_date);

    const expRow = expenses.byPeriod.get(p.id);
    const instList = inst.byPeriod.get(p.id) ?? [];
    const instTotal = instList.reduce((s, x) => s + x.amount, 0);
    const ov = savingsOv.get(p.id);
    // ручные суммы по целям: такая цель получает ровно введённое, остальные считаются
    const fixedGoals = ov ?? new Map();
    const manual = Boolean(p.locked);
    const payOv = cardOv.get(p.id) ?? new Map();

    let remaining = r.total;
    const allocations = {};
    const byStage = {};
    const debtPayments = {};
    const cardBefore = {};
    const cardOrder = [...cards].sort((a, b) => {
      const ka = cardState.get(a.id).deadline || '9999-99-99';
      const kb = cardState.get(b.id).deadline || '9999-99-99';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    let paceDone = false;
    const paceGiven = new Map();   // темп подушки, уже отложенный в этой выплате
    for (const s of stages) {
      const before = remaining;
      let paceSpent = 0;

      if (s.code === 'categories') {
        remaining -= expRow.total;
      } else if (s.code === 'installments') {
        remaining -= instTotal;
      } else if (s.code === 'credits') {
        for (const c of cardOrder) {
          const cs = cardState.get(c.id);
          cardBefore[c.id] = { debt: cs.debt, deadline: cs.deadline };
          const debtBase = fx.toBase(cs.debt, c.currency_code, p.pay_date);
          if (debtBase === null) { warnOnce('no_fx_rate', { card_id: c.id, currency: c.currency_code }); continue; }
          let pay;
          if (payOv.has(c.id)) pay = Math.min(Math.max(0, payOv.get(c.id)), debtBase);
          else if (p.locked) pay = 0;
          else pay = Math.min(fx.toBase(cardRequired(c, cs, p), c.currency_code, p.pay_date), Math.max(0, remaining), debtBase);
          if (pay > 0.0001) {
            debtPayments[c.id] = pay;
            remaining -= pay;
            cardApplyPayment(cs, fx.fromBase(pay, c.currency_code, p.pay_date), p.pay_date, cardCycles.get(c.id));
          }
        }
      } else if (SAVINGS_STAGES.includes(s.code)) {
        // сначала ручные суммы этого этапа: они забронированы и в расчёт не входят
        for (const g of goals.filter(x => stageOfGoal(x) === s.code && fixedGoals.has(x.id))) {
          const amt = fixedGoals.get(g.id) ?? 0;
          if (amt > 0.0001 && depositBase(g.id, amt, p.pay_date, allocations)) remaining -= amt;
        }
        if (!manual && remaining > 0) {
          // темп подушки идёт раньше копилок: если он задан, его откладываем обязательно
          if (paceFirst && !paceDone && s.code !== 'reserves') {
            paceSpent = reservePaceStep(p, allocations, fixedGoals, remaining, depositBase, paceGiven);
            remaining -= paceSpent;
            paceDone = true;
          }
          const reqs = paceOrder(activeGoals(s.code).filter(g => !fixedGoals.has(g.id)).map(g => requirement(g, p)), s.code);
          for (const req of reqs) {
            if (remaining <= 0) break;
            const b = inBase(req, p.pay_date);
            if (!b) continue;
            // темп, уже отложенный до копилок, второй раз не берём
            const per = b.perBase - (paceGiven.get(req.g.id) ?? 0);
            const give = Math.min(per, remaining, b.remainingBase);
            if (give > 0.0001 && depositBase(req.g.id, give, p.pay_date, allocations)) remaining -= give;
          }
        }
      }
      // темп подушки, отложенный внутри чужого этапа, считается этапом подушек
      byStage[s.code] = (byStage[s.code] ?? 0) + (before - remaining - paceSpent);
      if (paceSpent) byStage.reserves = (byStage.reserves ?? 0) + paceSpent;
    }

    /* доливка остатка: по одному этапу за раз, очередь строится заново */
    let cascaded = 0;
    if (!manual) {
      for (let guard = 0; remaining > 0.5 && guard < 60; guard++) {
        const pool = SAVINGS_STAGES.flatMap(code => activeGoals(code))
          .filter(g => !fixedGoals.has(g.id)).map(g => requirement(g, p));
        let next = null;
        for (const req of cascadeOrder(pool)) {
          if (req.remaining <= 0.0001) continue;
          const b = inBase(req, p.pay_date);
          if (b) { next = b; break; }
        }
        if (!next) break;
        const give = Math.min(next.remainingBase, remaining);
        if (give <= 0.0001 || !depositBase(next.g.id, give, p.pay_date, allocations)) break;
        remaining -= give;
        cascaded += give;
      }
    }

    /* досрочное погашение карт остатком */
    let early = 0;
    const credits = stage('credits');
    if (credits && credits.params?.early_repayment !== false && !p.locked && remaining > 0.5) {
      for (const c of cardOrder) {
        if (remaining <= 0.5 || payOv.has(c.id)) continue;
        const cs = cardState.get(c.id);
        const debtBase = fx.toBase(cs.debt, c.currency_code, p.pay_date);
        if (debtBase === null) continue;
        const extra = Math.min(debtBase, remaining);
        if (extra > 0.0001) {
          debtPayments[c.id] = (debtPayments[c.id] ?? 0) + extra;
          remaining -= extra;
          early += extra;
          cardApplyPayment(cs, fx.fromBase(extra, c.currency_code, p.pay_date), p.pay_date, cardCycles.get(c.id));
        }
      }
    }

    const snap = tracker.snapshot();
    rows.push({
      period: p,
      income: r,
      totalIncome: r.total,
      expenses: expRow,
      categoriesTotal: expRow.total,
      installments: instList,
      installmentsTotal: instTotal,
      // остаток после расходов и рассрочек — то, что показывается в заголовке выплаты
      free: r.total - expRow.total - instTotal,
      debtPayments,
      cardBefore,
      cardState: Object.fromEntries([...cardState].map(([k, v]) => [k, { ...v }])),
      allocations,
      byStage: { ...byStage, cascade: cascaded, early_repayment: early },
      manual,
      unallocated: remaining,
      goalBalances: snap.balances,
      phase: snap.phase,
    });
  }
  applyTxUpTo(null);
  applyCardOpsUpTo(null);

  return {
    income: inc,
    rows,
    byId: new Map(rows.map(x => [x.period.id, x])),
    stages,
    monthChecks: expenses.monthChecks,
    milestoneDates: tracker.milestoneDates(),
    milestoneFunded: tracker.milestoneFunded(),
    initialPhase,
    finalPhase: tracker.snapshot(),
    cardCycles: Object.fromEntries(cardCycles),
    planEnd: periods.length ? periods[periods.length - 1].pay_date : '',
    warnings,
    goals,
    milestonesOf: g => milestonesOf(g, milestones),
  };
}

/* ------------------------------------------------------------------ вопросы к расчёту */

export function lastRowAtOrBefore(sim, date) {
  let found = null;
  for (const r of sim.rows) { if (r.period.pay_date <= date) found = r; else break; }
  return found;
}

/* Сколько в копилке на дату (в валюте цели) */
export function goalBalanceAt(sim, goal, txs, date) {
  const row = lastRowAtOrBefore(sim, date);
  let bal = row ? (row.goalBalances[goal.id] ?? 0) : (Number(goal.starting_balance) || 0);
  const after = row ? row.period.pay_date : '';
  for (const t of txs) {
    if (t.goal_id !== goal.id || !t.date || t.date <= after || t.date > date) continue;
    const a = Math.abs(Number(t.amount) || 0);
    bal += (t.kind === 'spend' || t.kind === 'transfer_out') ? -a : a;
  }
  return bal;
}

/* Сколько засчитано в цель на дату */
export function goalProgressAt(sim, goal, date) {
  const row = lastRowAtOrBefore(sim, date);
  const phase = (row ? row.phase : sim.initialPhase.phase)[goal.id] ?? { idx: 0, saved: 0 };
  return progressOf(sim.milestonesOf(goal), phase);
}

/* Сколько цели не хватает до общей суммы на дату и ближайший срок незакрытого этапа */
export function goalNeedAt(sim, goal, txs, date) {
  const list = sim.milestonesOf(goal);
  const row = lastRowAtOrBefore(sim, date);
  const phase = (row ? row.phase : sim.initialPhase.phase)[goal.id] ?? { idx: 0, saved: 0 };
  let progress = progressOf(list, phase);
  const after = row ? row.period.pay_date : '';
  for (const t of txs) {
    if (t.goal_id === goal.id && t.date > after && t.date <= date && (t.kind === 'deposit' || t.kind === 'transfer_in')) {
      progress += Math.abs(Number(t.amount) || 0);
    }
  }
  const next = list.slice(phase.idx).find(m => m.deadline);
  const total = list.reduce((s, m) => s + m.target, 0);
  return { need: Math.max(0, total - progress), deadline: next?.deadline ?? '' };
}

/* Долг по карте на дату: после последней выплаты + операции после неё */
export function cardStateAt(sim, card, ops, date) {
  const row = lastRowAtOrBefore(sim, date);
  const cs = row?.cardState?.[card.id] ? { ...row.cardState[card.id] } : newCardState();
  const after = row ? row.period.pay_date : '';
  for (const o of sortedCardOps(ops, card.id)) if (o.op_date > after && o.op_date <= date) cardApplyOp(cs, card, o, null);
  return cs;
}

/* Прогноз закрытия текущего льготного периода */
export function cardForecast(sim, card, ops, date) {
  const state = cardStateAt(sim, card, ops, date);
  const cycle = state.debt > 0.5 ? (sim.cardCycles[card.id] ?? []).find(c => c.start === state.cycleStart) ?? null : null;
  return { state, cycle };
}

/* Темп подушки: сколько нужно за выплату, чтобы успеть к сроку этапа, и сколько
   в среднем свободно в будущих выплатах. Предлагается меньшее из двух. */
export function reservePaceSuggestion(sim, goal, today) {
  const future = sim.rows.filter(r => r.period.pay_date >= today);
  const list = sim.milestonesOf(goal);
  const row = lastRowAtOrBefore(sim, today);
  const phase = (row ? row.phase : sim.initialPhase.phase)[goal.id] ?? { idx: 0, saved: 0 };
  const stageNow = phase.idx < list.length ? list[phase.idx] : null;
  const need = stageNow ? Math.max(0, stageNow.target - phase.saved) : 0;
  const payoutsLeft = stageNow?.deadline
    ? future.filter(r => r.period.pay_date <= stageNow.deadline).length
    : future.length;
  const needPer = payoutsLeft > 0 ? need / payoutsLeft : need;
  const avgFree = future.length
    ? future.reduce((s, r) => s + Math.max(0, r.unallocated) + (r.allocations[goal.id] ?? 0), 0) / future.length
    : 0;
  return {
    stage: stageNow, need, payoutsLeft, needPer, avgFree,
    suggested: Math.min(Math.max(needPer, 0), avgFree),
    enough: avgFree + 0.5 >= needPer,
  };
}

/* Прогноз за пределами плана: если этап не закрывается внутри плана, считаем,
   с какой скоростью цель пополняется в последних выплатах, и продлеваем этот
   темп дальше. Возвращает { date, perPayout, payouts, beyondPlan: true } или null,
   когда цели ничего не достаётся — тогда прогноза нет вовсе. */
export function forecastBeyondPlan(sim, goal, milestoneIndex = null) {
  const rows = sim.rows;
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const list = sim.milestonesOf(goal);
  const phase = last.phase[goal.id] ?? { idx: 0, saved: 0 };
  const target = milestoneIndex === null ? phase.idx : milestoneIndex;
  if (target < phase.idx) return null;                       // этап уже закрыт в плане
  if (target >= list.length) return null;

  // сколько ещё нужно: остаток текущего этапа плюс все этапы до нужного
  let need = Math.max(0, (list[phase.idx]?.target ?? 0) - phase.saved);
  for (let i = phase.idx + 1; i <= target && i < list.length; i++) need += Number(list[i].target) || 0;
  if (need <= 0.5) return null;

  // темп: среднее пополнение за последние выплаты, где цель вообще получала деньги
  const tail = rows.slice(-12);
  const got = tail.reduce((s, r) => s + (r.allocations[goal.id] ?? 0), 0);
  const perPayout = tail.length ? got / tail.length : 0;
  if (perPayout <= 0.5) return null;

  const payouts = Math.ceil(need / perPayout);
  // средний промежуток между выплатами плана
  const first = rows[0].period.pay_date;
  const span = rows.length > 1 ? (Date.parse(last.period.pay_date) - Date.parse(first)) / (rows.length - 1) : 30 * 864e5;
  const date = new Date(Date.parse(last.period.pay_date) + payouts * span).toISOString().slice(0, 10);
  return { date, perPayout, payouts, beyondPlan: true };
}

/* Перераспределение остатка закрытой цели: сначала в цели с ближайшим сроком,
   каждой не больше, чем ей не хватает */
export function proposeRedistribution(sim, closedGoal, balance, date, txs) {
  const cands = sim.goals
    .filter(g => g.id !== closedGoal.id && !g.completed)
    .map(g => ({ g, ...goalNeedAt(sim, g, txs, date) }))
    .sort((a, b) => {
      const ka = a.deadline || '9999-99-99';
      const kb = b.deadline || '9999-99-99';
      return ka !== kb ? (ka < kb ? -1 : 1) : (a.g.priority ?? 0) - (b.g.priority ?? 0);
    });
  let left = Math.round(balance);
  return cands.map(c => {
    const give = Math.max(0, Math.min(left, Math.round(c.need)));
    left -= give;
    return { goal_id: c.g.id, title: c.g.title, need: Math.round(c.need), deadline: c.deadline, amount: give };
  });
}

/* Фиксация прошедших выплат: что записать, чтобы расчёт превратился в факт.
   Возвращает строки для patch'ей: периоды с locked = true, суммы в копилки и
   ненулевые погашения карт (уже вписанные ручные погашения не перезаписываются). */
export function freezePeriods(state, sim, ids, round = Math.round) {
  const set = new Set(ids);
  const periods = (state.income?.periods ?? []).map(p => (set.has(p.id) ? { ...p, locked: true } : p));
  const savings = [...(state.savings?.savings_period_overrides ?? [])];
  const payments = [...(state.debts?.credit_payment_overrides ?? [])];
  for (const id of set) {
    const row = sim.byId.get(id);
    if (!row) continue;
    const hasOwn = savings.some(o => o.period_id === id);
    if (!hasOwn) {
      for (const [gid, amt] of Object.entries(row.allocations)) {
        savings.push({ period_id: id, goal_id: gid, amount: round(amt) });
      }
    }
    for (const [cid, amt] of Object.entries(row.debtPayments)) {
      if (!payments.some(o => o.period_id === id && o.card_id === cid)) {
        payments.push({ period_id: id, card_id: cid, amount: round(amt) });
      }
    }
  }
  return { periods, savings_period_overrides: savings, credit_payment_overrides: payments };
}

