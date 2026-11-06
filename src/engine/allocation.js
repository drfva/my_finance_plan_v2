/* ---------------------------------------------------------------------
   allocation.js — конвейер распределения выплат.

     const sim = simulate(store.state, store.config());
     sim.rows            → по каждой выплате: доход, этапы, суммы в цели, погашения, остаток
     sim.byId            → то же по id выплаты
     sim.milestoneDates  → когда закрывается каждый этап каждой цели
     sim.milestoneFunded → сколько денег закрытого этапа ещё лежит в копилке
     sim.ledgerOf(id)    → все движения по копилке: отчисления плана, траты, переводы
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

   Темп подушки (pace_amount) откладывается только на этапе reserves, на его
   месте в заданной очереди. Более ранние этапы сначала получают нужные взносы,
   затем из оставшихся денег рассчитывается посильный темп подушек. Цели могут
   копиться параллельно; полностью заполнять все копилки до подушек не требуется.
   Опция paceFirst: false отключает адаптивный темп для сверки со старым расчётом.

   После этапов — доливка остатка по целям: по одному этапу за раз, у кого срок
   ближе; цели без срока — по приоритету. Группы подарков, копилок и подушек
   следуют порядку этапов. Затем свободный остаток идёт в досрочные погашения
   по очереди этапов долгов: credits включён по умолчанию, installments —
   только при params.early_repayment = true. Проведённые части рассрочек
   сохраняются в installment_snapshot выплаты и уменьшают будущий долг.

   Зафиксированная выплата (locked) автоматически в цели не распределяется:
   в цели идут только ручные суммы, нет автоматических погашений карт.
   Ручная сумма отдельной цели (savings_period_overrides) закрепляет только её;
   остальные цели получают автоматическое распределение.

   Все суммы конвейера — в базовой валюте. Суммы целей и карт в другой валюте
   переводятся по курсу на дату выплаты (fx.js). Для будущих накоплений берётся
   действующий на сегодня курс; зафиксированные выплаты используют историю курсов.
--------------------------------------------------------------------- */

import { computeIncome } from './income.js';
import { planExpenses } from './expenses.js';
import { newCardState, sortedCardOps, cardApplyOp, cardApplyPayment } from './debts.js';
import { createInstallmentAllocator } from './installment-allocation.js';
import { createTracker, milestonesOf, progressOf } from './savings.js';
import { createFx } from './fx.js';
import { createFamilyAllocator } from './family.js';

const SAVINGS_STAGES = ['gifts', 'buckets', 'reserves'];

/* Одинаковый посильный темп: выплаты с меньшим остатком отдают доступную часть,
   остальные делят бюджет поровну. Это не резервирует полный желаемый темп
   в будущем за счёт пропуска взноса сегодня. */
function paceWithinBudget(capacities, budget, requested) {
  const caps = capacities.map(x => Math.max(0, x)).sort((a, b) => a - b);
  let left = Math.max(0, budget);
  for (let i = 0; i < caps.length; i++) {
    const share = left / (caps.length - i);
    if (share <= caps[i]) return Math.min(requested, share);
    left -= caps[i];
  }
  return requested;
}

/* Сначала строим план, затем проверяем доступность будущих выплат. Если позднее
   денег мало, переносим нужное накопление вперёд за счёт менее срочных целей. */
export function simulate(state, cfg, options = {}) {
  const income = options.income ?? computeIncome(state, cfg, { round: options.round });
  let result = simulatePlan(state, cfg, { ...options, income });
  for (let i = 0; i < 4; i++) {
    const next = simulatePlan(state, cfg, { ...options, income, reference: result });
    const same = next.rows.every((r, n) => JSON.stringify(r.allocations) === JSON.stringify(result.rows[n].allocations)
      && JSON.stringify(r.reservePaces) === JSON.stringify(result.rows[n].reservePaces)
      && JSON.stringify(r.installmentDetails) === JSON.stringify(result.rows[n].installmentDetails)
      && r.familyContribution?.amount === result.rows[n].familyContribution?.amount);
    result = next;
    if (same) break;
  }
  return result;
}

function simulatePlan(state, cfg, { income = null, round = Math.round, paceFirst = true, today = '', reference = null } = {}) {
  const inc = income ?? computeIncome(state, cfg, { round });
  const periods = inc.periods.map(r => r.period);
  const warnings = [...inc.warnings];
  const warned = new Set();
  const warnOnce = (code, extra) => {
    const key = code + JSON.stringify(extra);
    if (!warned.has(key)) { warned.add(key); warnings.push({ code, ...extra }); }
  };

  const fxRates = [...(state.settings?.fx_rates ?? []), ...(state.current_fx?.rates ?? [])];
  const fx = createFx(fxRates, cfg.get('base_currency'));
  const savingsFx = createFx(fxRates, cfg.get('base_currency'), { asOf: today });
  const family = createFamilyAllocator({ state, income: inc, reference, round });
  const stages = cfg.stages().filter(s => s.enabled || s.code === 'family' && family.posted.size);
  const stage = code => stages.find(s => s.code === code) ?? null;

  /* какой этап отвечает за цель: по справочнику типов целей */
  const kindStage = new Map(cfg.list('goal_kinds').map(k => [k.code, k.stage_code]));
  const stageOfGoal = g => kindStage.get(g.kind_code) ?? 'buckets';

  /* ---------------------------------------------------------- расходы и рассрочки */
  const exp = state.expenses ?? {};
  const percentBase = stage('categories')?.params?.percent_base === 'gross'
    ? p => (inc.byId.get(p.id)?.formula?.gross ?? (p.calc_mode === 'manual' || p.sick_leave_id ? inc.byId.get(p.id)?.gross ?? 0 : 0)) + (inc.byId.get(p.id)?.sickGross ?? 0)
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
  const inst = createInstallmentAllocator(debts.installments ?? [], debts.installment_payments ?? [], periods);
  if (inst.outside.length) warnOnce('installments_before_plan', { count: inst.outside.length });

  /* ---------------------------------------------------------- накопления */
  const sv = state.savings ?? {};
  const goals = sv.goals ?? [];
  const milestones = sv.goal_milestones ?? [];
  const tracker = createTracker({ goals, milestones, today });
  const initialPhase = tracker.snapshot('');
  const txs = (sv.goal_transactions ?? []).filter(t => t.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let txPtr = 0;
  const applyTxUpTo = date => {
    while (txPtr < txs.length && (date === null || txs[txPtr].date <= date)) tracker.apply(txs[txPtr++]);
  };

  let curPeriodId = null;        // выплата, из которой идёт текущее отчисление — для «движений»

  const savingsOv = new Map();
  const goalsById = new Map(goals.map(g => [g.id, g]));
  const periodsById = new Map(periods.map(p => [p.id, p]));
  const goalFx = (p = periodsById.get(curPeriodId)) => p?.locked ? fx : savingsFx;
  for (const o of sv.savings_period_overrides ?? []) {
    const g = goalsById.get(o.goal_id);
    const p = periodsById.get(o.period_id);
    if (!g || !p) continue;
    // Ручные суммы закрытой цели сохраняют историю, но не будущие пополнения.
    if ((g.completed || g.archived) && !(g.completion_snapshot?.date
      ? p.pay_date <= g.completion_snapshot.date : p.locked && (!today || p.pay_date <= today))) continue;
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
  const projectedInstallments = createInstallmentAllocator(debts.installments ?? [], debts.installment_payments ?? [], periods);
  for (const r of inc.periods) {
    const p = r.period;
    const ov = savingsOv.get(p.id);
    const committed = (p.locked || ov?.size) ? [...(ov?.values() ?? [])].reduce((s, x) => s + x, 0) : 0;
    projectedInstallments.step(p);
    const parts = reference?.byId.get(p.id)?.installmentDetails?.filter(d => p.locked || !d.early) ?? projectedInstallments.details(p);
    const instTotal = parts.reduce((s, x) => s + x.amount, 0);
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
  /* Сколько цель просит из выплаты сейчас (темп) и сколько ей не хватает до конца
     текущего этапа — в валюте цели; deadline — срок, к которому она спешит */
  function requirement(g, p, through = null) {
    const list = tracker.milestones(g.id);
    const { idx, saved } = tracker.phase(g.id);
    const reserve = stageOfGoal(g) === 'reserves';
    // этапы без срока впереди не прячут срок следующего: цель спешит к ближайшему сроку
    let look = through ?? (idx < list.length ? idx : list.findIndex(m => m.deadline && m.deadline > p.pay_date));
    if (look < 0) return { g, reserve, remaining: 0, per: 0, deadline: '' };
    // При проверке отдельных сроков долг текущего этапа не относится к уже
    // завершённым. Их будущие траты всё равно учитываются ниже: они ещё могут
    // открыть накопленный заранее этап, чей срок впереди.
    const debt = through !== null && look < idx ? 0 : Math.max(0, -tracker.balance(g.id));
    let need = list.slice(idx, look + 1).reduce((s, m) => s + m.target, 0) - saved + debt;
    let deadline = list[look]?.deadline || '';
    while (!deadline && look + 1 < list.length) {
      look++;
      need += list[look].target;
      deadline = list[look].deadline || '';
    }
    // Трата до срока может съесть текущий прогресс или открыть будущий этап.
    // Резервы уже прошедших этапов оплачивают такие траты первыми.
    const pools = tracker.reserves(g.id);
    const plannedPaid=tracker.paid(g.id);
    const original=milestonesOf(g,milestones);
    // При проверке нескольких этапов считаем также резервы, которые предстоит
    // накопить к промежуточным срокам: их штатная трата не требует второй копии суммы.
    for (let i = idx; i < look; i++) pools.push({ deadline: list[i].deadline || '', left: list[i].target });
    for (const t of txs) {
      if (t.goal_id !== g.id || t.date <= p.pay_date || !deadline || t.date >= deadline) continue;
      let amount = Math.abs(Number(t.amount) || 0);
      if (t.kind !== 'spend' && t.kind !== 'transfer_out') { need -= amount; continue; }
      if(t.kind==='spend'&&t.purpose==='goal'){
        const index=original.findIndex(m=>m.id===(t.milestone_id||'_main'));
        if(index>=0&&index<=look){
          const credit=Math.min(amount,Math.max(0,original[index].target-(plannedPaid[index]??0)));
          plannedPaid[index]=(plannedPaid[index]??0)+credit;amount-=credit;
        }
      }
      for (const c of pools) {
        if (!c.deadline || !(c.deadline <= t.date || (today && c.deadline < today))) continue;
        const take = Math.min(amount, c.left);
        c.left -= take;
        amount -= take;
      }
      need += amount;
    }
    need = Math.max(0, need);
    const remaining = need;
    const eligible = periods.filter(q => q.pay_date >= p.pay_date && q.pay_date <= deadline);
    let fixedFuture = 0;
    let n = 0;
    for (const q of eligible) {
      const fixed = savingsOv.get(q.id);
      if (q.pay_date > p.pay_date && fixed?.has(g.id)) fixedFuture += goalFx(q).fromBase(fixed.get(g.id), g.currency_code, q.pay_date) ?? 0;
      else if (!q.locked && !fixed?.has(g.id)) n++;
    }
    const overdue = Boolean(deadline && deadline < p.pay_date && need > 0);
    const paced = Math.max(0, need - fixedFuture);
    const even = deadline ? ((overdue || n <= 0) ? paced : paced / n) : 0;
    const per = Math.min(remaining, Math.max(even, reserve ? Number(g.pace_amount) || 0 : 0));
    return { g, reserve, remaining, maximum: paced, per, requiredPer: Math.min(remaining, even), deadline };
  }

  /* Посильный темп подушек на их этапе, после взносов предшествующих этапов.
     Возвращает, сколько ушло из оставшихся денег выплаты. */
  function reservePaceStep(p, allocations, fixedGoals, remaining, deposit, given) {
    let spent = 0;
    const list = activeGoals('reserves')
      .filter(g => (Number(g.pace_amount) || 0) > 0)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const [index, g] of list.entries()) {
      if (fixedGoals.has(g.id)) continue;
      const left = remaining - spent;
      if (left <= 0.5) break;
      const req = requirement(g, p);
      const b = inBase(req, p.pay_date);
      if (!b) continue;
      const paceBase = goalFx(p).toBase(Number(g.pace_amount) || 0, g.currency_code, p.pay_date);
      if (paceBase === null) continue;
      // Темп подушки можно снизить ради сроков подарков и копилок.
      // Собственный срок подушки не превращает этот взнос в обязательный.
      const limits = fundingLimits({ ...req, deadline: '', reservePace: true,
        paceBefore: new Set(list.slice(0, index).map(x => x.id)), paceBase }, p, fixedGoals, allocations, left);
      const give = Math.min(paceBase, limits.paceLimit, Math.max(0, left - limits.protect), b.remainingBase);
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
    const per = goalFx().toBase(req.per, code, date);
    const required = goalFx().toBase(req.requiredPer ?? 0, code, date);
    const remaining = goalFx().toBase(req.maximum ?? req.remaining, code, date);
    if (per === null || remaining === null) {
      warnOnce('no_fx_rate', { goal_id: req.g.id, currency: code });
      return null;
    }
    return { ...req, perBase: per, requiredBase: required ?? 0, remainingBase: remaining };
  }

  function depositBase(gid, amountBase, date, allocations) {
    const g = goals.find(x => x.id === gid);
    const inGoal = g ? goalFx().fromBase(amountBase, g.currency_code, date) : null;
    if (inGoal === null) { warnOnce('no_fx_rate', { goal_id: gid, currency: g?.currency_code }); return false; }
    tracker.deposit(gid, inGoal, date, { source: 'plan', period_id: curPeriodId });
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

  /* Доливка следует той же очереди этапов, что и обязательные взносы. */
  const stageRanks = new Map(stages.map((s, index) => [s.code, index]));
  const tierOf = code => stageRanks.get(code) ?? Infinity;

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

  const activeGoals = code => goals.filter(g => !g.completed && !g.archived && stageOfGoal(g) === code && stage(code));

  /* Более поздний этап конвейера тоже может иметь ближайший срок. Оставляем
     ему минимум сейчас, если из будущих выплат он уже не успеет накопиться. */
  function fundingLimits(req, p, fixedGoals, allocations, availableNow = 0) {
    const pending = g => Math.max(0, (fixedGoals.get(g.id) ?? 0) - (allocations[g.id] ?? 0));
    const enabled = goals.filter(g => stage(stageOfGoal(g)));
    const manual = enabled.reduce((s, g) => s + pending(g), 0);
    let protect = manual;
    let minimum = 0;
    let paceLimit = Infinity;
    if (!reference) return { protect, minimum, paceLimit };
    const needs = enabled.filter(g => !g.completed && !g.archived
      && (!req.reservePace || stageOfGoal(g) !== 'reserves')
      // Срок подушки ниже в очереди не перехватывает деньги более ранней цели.
      && !(stageOfGoal(g) === 'reserves' && stageOfGoal(req.g) !== 'reserves'
        && tierOf('reserves') > tierOf(stageOfGoal(req.g)))).flatMap(g => {
      return tracker.milestones(g.id).map((m, i) => {
        if (!m.deadline) return null;
        const r = requirement(g, p, i);
        return { g, deadline: r.deadline, amount: Math.max(0, (goalFx(p).toBase(r.remaining, g.currency_code, p.pay_date) ?? 0) - pending(g)) };
      }).filter(Boolean);
    }).filter(r => r.deadline && r.amount > 0.0001);
    const currentIndex = reference.rows.findIndex(r => r.period.id === p.id);
    for (const deadline of new Set(needs.map(r => r.deadline))) {
      const byGoal = new Map();
      for (const r of needs) if (r.deadline <= deadline && r.amount > (byGoal.get(r.g.id)?.amount ?? 0)) byGoal.set(r.g.id, r);
      const group = [...byGoal.values()];
      const ids = new Set(group.map(r => r.g.id));
      const need = group.reduce((s, r) => s + r.amount, 0);
      let capacity = 0;
      const paceCapacities = [Math.max(0, availableNow - manual)];
      for (const [index, row] of reference.rows.entries()) {
        const q = row.period;
        if (index <= currentIndex || q.pay_date > deadline) continue;
        const fixed = savingsOv.get(q.id) ?? new Map();
        let available = group.reduce((s, r) => s + (fixed.get(r.g.id) ?? 0), 0);
        if (!q.locked && group.some(r => !fixed.has(r.g.id))) {
          let free = row.unallocated;
          for (const g of enabled) {
            if (fixed.has(g.id)) continue;
            const amount = row.allocations[g.id] ?? 0;
            const keepPace = !ids.has(g.id) && paceFirst && stageOfGoal(g) === 'reserves'
              && (req.reservePace ? req.paceBefore.has(g.id)
                : stageOfGoal(req.g) === 'reserves' || tierOf('reserves') < tierOf(stageOfGoal(req.g)));
            const pace = keepPace ? row.reservePaces[g.id] ?? 0 : 0;
            free += Math.max(0, amount - pace);
          }
          available += Math.max(0, free);
          if (req.reservePace && !fixed.has(req.g.id)) paceCapacities.push(Math.max(0, free));
        }
        capacity += available;
      }
      // Ручная сумма не допускает дополнительного взноса в эту цель сейчас.
      // Учитываем её будущую потребность вместе с остальными сроками, но не
      // удерживаем больше, чем цели группы вообще могут получить сегодня.
      const actionable = group.reduce((sum, r) => sum + (fixedGoals.has(r.g.id) ? 0 : r.amount), 0);
      const effectiveNeed = Math.min(need, capacity + actionable);
      const now = Math.max(0, effectiveNeed - capacity);
      if (req.reservePace) paceLimit = Math.min(paceLimit,
        paceWithinBudget(paceCapacities, availableNow - manual + capacity - effectiveNeed, req.paceBase));
      if (req.deadline && req.deadline <= deadline) minimum = Math.max(minimum, now);
      else protect = Math.max(protect, manual + now);
    }
    return { protect, minimum, paceLimit };
  }

  /* ---------------------------------------------------------- проход по выплатам */
  const rows = [];
  for (const r of inc.periods) {
    const p = r.period;
    curPeriodId = p.id;
    applyTxUpTo(p.pay_date);
    applyCardOpsUpTo(p.pay_date);

    const expRow = expenses.byPeriod.get(p.id);
    inst.step(p);
    let instTotal = inst.details(p).reduce((s, x) => s + x.amount, 0);
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
    if (p.locked && Array.isArray(p.installment_snapshot) && !stage('installments')) {
      remaining -= instTotal;
      byStage.installments = instTotal;
    }
    const cardOrder = [...cards].sort((a, b) => {
      const ka = cardState.get(a.id).deadline || '9999-99-99';
      const kb = cardState.get(b.id).deadline || '9999-99-99';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const paceGiven = new Map();   // темп подушки, уже отложенный в этой выплате
    let familyContribution = null;
    for (const s of stages) {
      const before = remaining;

      if (s.code === 'family') {
        familyContribution = family.step(p, remaining, { enabled: s.enabled });
        remaining -= familyContribution.amount;
      } else if (s.code === 'categories') {
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
          // Темп не перескакивает через предшествующие этапы конвейера.
          if (paceFirst && s.code === 'reserves') {
            remaining -= reservePaceStep(p, allocations, fixedGoals, remaining, depositBase, paceGiven);
          }
          const reqs = paceOrder(activeGoals(s.code).filter(g => !fixedGoals.has(g.id)).map(g => requirement(g, p)), s.code);
          for (const req of reqs) {
            if (remaining <= 0) break;
            const b = inBase(req, p.pay_date);
            if (!b) continue;
            // Посильный темп уже отложен: не добираем его до полного желаемого
            // повторно. Дополнительный обязательный взнос возможен ради срока.
            const per = (req.reserve && paceFirst ? b.requiredBase : b.perBase) - (paceGiven.get(req.g.id) ?? 0);
            const limits = fundingLimits(req, p, fixedGoals, allocations);
            const available = Math.max(0, remaining - limits.protect);
            const give = Math.min(Math.max(per, limits.minimum), available, b.remainingBase);
            if (give > 0.0001 && depositBase(req.g.id, give, p.pay_date, allocations)) remaining -= give;
          }
        }
      }
      byStage[s.code] = (byStage[s.code] ?? 0) + (before - remaining);
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
          if (b && b.remainingBase > 0.0001 && remaining - fundingLimits(b, p, fixedGoals, allocations).protect > 0.0001) { next = b; break; }
        }
        if (!next) break;
        const available = Math.max(0, remaining - fundingLimits(next, p, fixedGoals, allocations).protect);
        const give = Math.min(next.remainingBase, available);
        if (give <= 0.0001 || !depositBase(next.g.id, give, p.pay_date, allocations)) break;
        remaining -= give;
        cascaded += give;
      }
    }

    /* Досрочные погашения — только из свободного остатка после распределения.
       Очередь кредиток и рассрочек совпадает с очередью их обычных этапов. */
    let early = 0;
    let earlyInstallments = 0;
    for (const debtStage of stages.filter(s => ['credits','installments'].includes(s.code))) {
      if (p.locked || remaining <= 0.5) break;
      if (debtStage.code === 'installments') {
        if (debtStage.params?.early_repayment === true) {
          const paid = inst.prepay(p, Math.max(0, remaining));
          remaining -= paid; instTotal += paid; earlyInstallments += paid; early += paid;
        }
        continue;
      }
      if (debtStage.params?.early_repayment === false) continue;
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

    const snap = tracker.snapshot(p.pay_date);
    rows.push({
      period: p,
      income: r,
      totalIncome: r.total,
      expenses: expRow,
      categoriesTotal: expRow.total,
      installments: inst.groups(p),
      installmentDetails: inst.details(p),
      installmentsTotal: instTotal,
      // остаток после расходов и рассрочек — то, что показывается в заголовке выплаты
      free: r.total - expRow.total - instTotal,
      debtPayments,
      familyContribution,
      cardBefore,
      cardState: Object.fromEntries([...cardState].map(([k, v]) => [k, { ...v }])),
      allocations,
      reservePaces: Object.fromEntries(paceGiven),
      goalAllocations: Object.fromEntries(Object.entries(allocations).map(([id, amount]) =>
        [id, goalFx(p).fromBase(amount, goalsById.get(id)?.currency_code, p.pay_date) ?? 0])),
      byStage: { ...byStage, cascade: cascaded, early_repayment: early, early_installments: earlyInstallments },
      manual,
      unallocated: remaining,
      goalBalances: snap.balances,
      phase: snap.phase,
    });
  }
  curPeriodId = null;
  applyTxUpTo(null);
  applyCardOpsUpTo(null);

  return {
    installmentSchedule: inst.schedule(),
    income: inc,
    rows,
    byId: new Map(rows.map(x => [x.period.id, x])),
    stages,
    monthChecks: expenses.monthChecks,
    milestoneDates: tracker.milestoneDates(),
    milestoneFunded: tracker.milestoneFunded(),
    ledgerOf: gid => tracker.ledger(gid),
    initialPhase,
    finalPhase: tracker.snapshot(),
    cardCycles: Object.fromEntries(cardCycles),
    planEnd: periods.length ? periods[periods.length - 1].pay_date : '',
    warnings,
    savingsFx,
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
  if (goal.completed && goal.completion_snapshot && date >= goal.completion_snapshot.date) {
    return goal.completion_snapshot.progress;
  }
  const phase=goalPhaseAt(sim,goal,date);
  return progressOf(sim.milestonesOf(goal), phase);
}

export function goalPhaseAt(sim,goal,date){
  const entry=sim.ledgerOf?.(goal.id)?.filter(e=>!e.date||e.date<=date).at(-1);
  if(entry)return entry.phase;
  const row=lastRowAtOrBefore(sim,date);
  return (row?row.phase:sim.initialPhase.phase)[goal.id]??{idx:0,saved:0};
}

export function goalMilestoneAt(sim,goal,index,date){
  const list=sim.milestonesOf(goal),phase=goalPhaseAt(sim,goal,date),m=list[index];
  if(!m)return {balance:0,paid:0,need:0};
  const paid=phase.paid?.[index]??0;
  const txs=sim.ledgerOf?.(goal.id)??[];
  const entry=txs.filter(e=>!e.date||e.date<=date).at(-1),accountBalance=entry?.balance??(Number(goal.starting_balance)||0);
  let cash=Math.max(0,accountBalance);
  for(let i=0;i<index;i++)cash-=Math.min(Math.max(0,cash),Math.max(0,list[i].target-(phase.paid?.[i]??0)));
  const balance=Math.min(Math.max(0,cash),Math.max(0,m.target-paid));
  const actual=entry?.stageBalances?.[index]??balance;
  const purchaseDebt=phase.purchaseDebt?.[index]??0;
  const unassignedDebt=Math.max(0,-accountBalance-(phase.purchaseDebt??[]).slice(phase.idx).reduce((s,x)=>s+x,0));
  return {balance:actual,paid,need:phase.idx>index?0:Math.max(0,m.target-paid+purchaseDebt-actual)+(index===phase.idx?unassignedDebt:0)};
}

/* Фиксируем только уже случившиеся движения: прогноз будущих выплат не засчитывается.
   Повторяем журнал, чтобы учесть также траты/пополнения между выплатами и после
   последней выплаты. При повторном открытии снимок больше не используется. */
export function snapshotGoalCompletion(sim, goal, date) {
  const milestones = sim.milestonesOf(goal);
  const tracker = createTracker({ goals: [{ ...goal, completed: false }], milestones, today: date });
  for (const e of sim.ledgerOf(goal.id)) {
    if (!e.date || e.date > date) continue;
    if(e.note?.source==='tx')tracker.apply({id:e.note.id,goal_id:goal.id,date:e.date,amount:Math.abs(e.delta),kind:e.note.kind,title:e.note.title,milestone_id:e.note.milestone_id,purpose:e.note.purpose});
    else if (e.delta >= 0) tracker.deposit(goal.id, e.delta, e.date);
    else tracker.withdraw(goal.id, -e.delta, e.date);
  }
  const phase = tracker.phase(goal.id);
  const dates = tracker.milestoneDates()[goal.id];
  return {
    date, phase, progress: progressOf(milestones, phase),
    milestones: milestones.map((m, i) => ({ id: m.id, date: dates[i] })),
  };
}

/* Сколько цели не хватает до общей суммы на дату и ближайший срок незакрытого этапа */
export function goalNeedAt(sim, goal, txs, date) {
  if (goal.completed || goal.archived) return { need: 0, deadline: '' };
  const list = sim.milestonesOf(goal);
  const phase=goalPhaseAt(sim,goal,date);
  const progress=progressOf(list,phase);
  const next = list.slice(phase.idx).find(m => m.deadline);
  const total = list.reduce((s, m) => s + m.target, 0);
  const purchaseDebt=(phase.purchaseDebt??[]).slice(phase.idx).reduce((s,x)=>s+x,0);
  const extraDebt=Math.max(0,-goalBalanceAt(sim,goal,txs,date)-purchaseDebt);
  return { need: Math.max(0, total - progress)+extraDebt, deadline: next?.deadline ?? '' };
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
  if (goal.completed || goal.archived) return { stage: null, need: 0, payoutsLeft: 0, needPer: 0, avgFree: 0, suggested: 0, enough: true };
  const future = sim.rows.filter(r => r.period.pay_date >= today);
  const list = sim.milestonesOf(goal);
  const row = lastRowAtOrBefore(sim, today);
  const phase = goalPhaseAt(sim,goal,today);
  const stageNow = phase.idx < list.length ? list[phase.idx] : null;
  const balance=sim.ledgerOf(goal.id).filter(e=>!e.date||e.date<=today).at(-1)?.balance??(Number(goal.starting_balance)||0);
  const need = stageNow ? Math.max(0, stageNow.target - phase.saved-(phase.paid?.[phase.idx]??0))+Math.max(0,-balance) : 0;
  const payoutsLeft = stageNow?.deadline
    ? future.filter(r => r.period.pay_date <= stageNow.deadline).length
    : future.length;
  const needPer = payoutsLeft > 0 ? need / payoutsLeft : need;
  const avgFree = future.length
    ? future.reduce((s, r) => s + Math.max(0, r.unallocated) + (r.allocations[goal.id] ?? 0), 0) / future.length
    : 0;
  const avgFreeInGoal = sim.savingsFx?.fromBase(avgFree, goal.currency_code, today) ?? (sim.savingsFx ? 0 : avgFree);
  return {
    stage: stageNow, need, payoutsLeft, needPer, avgFree,
    suggested: Math.min(Math.max(needPer, 0), avgFreeInGoal),
    enough: avgFreeInGoal + (sim.savingsFx?.fromBase(0.5, goal.currency_code, today) ?? 0.5) >= needPer,
  };
}

/* Прогноз за пределами плана: если этап не закрывается внутри плана, считаем,
   с какой скоростью цель пополняется в последних выплатах, и продлеваем этот
   темп дальше. Возвращает { date, perPayout, payouts, beyondPlan: true } или null,
   когда цели ничего не достаётся — тогда прогноза нет вовсе. */
export function forecastBeyondPlan(sim, goal, milestoneIndex = null) {
  if (goal.completed || goal.archived) return null;
  const rows = sim.rows;
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const list = sim.milestonesOf(goal);
  const phase = last.phase[goal.id] ?? { idx: 0, saved: 0 };
  const target = milestoneIndex === null ? phase.idx : milestoneIndex;
  if (target < phase.idx) return null;                       // этап уже закрыт в плане
  if (target >= list.length) return null;

  // сколько ещё нужно: остаток текущего этапа плюс все этапы до нужного
  let need = Math.max(0, (list[phase.idx]?.target ?? 0) - phase.saved-(phase.paid?.[phase.idx]??0));
  need += Math.max(0,-(last.goalBalances[goal.id]??0));
  for (let i = phase.idx + 1; i <= target && i < list.length; i++) need += Math.max(0,(Number(list[i].target)||0)-(phase.paid?.[i]??0));
  if (need <= 0.5) return null;

  // темп: среднее пополнение за последние выплаты, где цель вообще получала деньги
  const regular = rows.filter(r => !r.period.sick_leave_id);
  const tail = regular.slice(-12);
  const got = tail.reduce((s, r) => {
    const pool = Object.values(r.allocations).reduce((n, amount) => n + amount, 0) + Math.max(0, r.unallocated);
    // Больничный уже увеличил фактический прогресс. Для продления регулярного
    // темпа убираем его разовую часть из доступного для накопления остатка.
    const regularShare = pool > 0 ? Math.max(0, pool - (r.income.sickPay ?? 0)) / pool : 0;
    const amount = (r.allocations[goal.id] ?? 0) * regularShare;
    const converted = r.goalAllocations?.[goal.id] !== undefined ? r.goalAllocations[goal.id] * regularShare
      : sim.savingsFx?.fromBase(amount, goal.currency_code) ?? (sim.savingsFx ? 0 : amount);
    return s + converted;
  }, 0);
  const perPayout = tail.length ? got / tail.length : 0;
  if (perPayout <= 0.0001) return null;

  const payouts = Math.ceil(need / perPayout);
  // средний промежуток между выплатами плана
  const first = regular[0].period.pay_date;
  const span = regular.length > 1 ? (Date.parse(regular.at(-1).period.pay_date) - Date.parse(first)) / (regular.length - 1) : 30 * 864e5;
  const date = new Date(Date.parse(last.period.pay_date) + payouts * span).toISOString().slice(0, 10);
  return { date, perPayout, payouts, beyondPlan: true };
}

/* Перераспределение остатка закрытой цели: сначала в цели с ближайшим сроком,
   каждой не больше, чем ей не хватает */
export function proposeRedistribution(sim, closedGoal, balance, date, txs) {
  const cands = sim.goals
    .filter(g => g.id !== closedGoal.id && !g.completed && !g.archived)
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
  const periods = (state.income?.periods ?? []).map(p => (set.has(p.id)
    ? { ...p, income_net: sim.byId.get(p.id)?.income.salary ?? p.income_net, locked: true,
        ...(!p.sick_leave_id ? { sick_snapshot: sim.byId.get(p.id)?.income.sickParts ?? [] } : {}),
        ...('installment_snapshot' in p || sim.byId.get(p.id)?.installmentDetails?.length
          ? { installment_snapshot: sim.byId.get(p.id)?.installmentDetails ?? [] } : {}) } : p));
  const savings = [...(state.savings?.savings_period_overrides ?? [])];
  const payments = [...(state.debts?.credit_payment_overrides ?? [])];
  for (const id of set) {
    const row = sim.byId.get(id);
    if (!row) continue;
    for (const [gid, amt] of Object.entries(row.allocations)) {
      if (!savings.some(o => o.period_id === id && o.goal_id === gid)) {
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

