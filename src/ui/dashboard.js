/* ---------------------------------------------------------------------
   dashboard.js — Обзор года.

   Четыре плитки сверху — переключатели: доход, расходы и отложенное в цели
   показывают разный разбор года ниже. «Свободный остаток» только считается.
--------------------------------------------------------------------- */

import { esc, card, table, pill } from './dom.js';
import { goalBalanceAt } from '../engine/allocation.js';
import { goalTotal } from '../engine/savings.js';
import { giftPlanTable } from './gifts.js';

export const code = 'dashboard';
export const title = () => 'Обзор';
export const hasYears = true;

const WARNINGS = {
  no_salary_rate: 'у выплаты нет оклада на дату — доход по формуле не считается',
  no_fx_rate: 'нет курса валюты — цель или карта пропущены',
  extra_before_plan: 'разовый доход раньше первой выплаты плана',
  installments_before_plan: 'платежи рассрочки раньше первой выплаты плана',
  vacation_outside_plan: 'отпуск выходит за расчётные периоды выплат плана',
};

const VIEWS = ['income', 'expenses', 'saved'];
const monthOf = r => (r.period.window_start || r.period.pay_date).slice(0, 7);
const sumOf = obj => Object.values(obj ?? {}).reduce((s, x) => s + x, 0);

/* ------------------------------------------------------- доход по месяцам */

function incomeView(ctx, rows) {
  const { fmt, year } = ctx;
  const slots = [...new Set(rows.map(r => r.period.slot_order))].sort((a, b) => a - b);
  const slotTitle = o => rows.find(r => r.period.slot_order === o)?.period.title || `Выплата ${o}`;

  const months = new Map();
  for (const r of rows) {
    const m = monthOf(r);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(r);
  }

  const rateCell = parts => {
    if (!parts.length) return '<td class="num muted">—</td>';
    if (parts.length === 1) return `<td class="num">${esc(fmt.percent(parts[0].rate, 0))}</td>`;
    return `<td class="num">${esc(parts.map(p => fmt.percent(p.rate, 0)).join(' + '))}
      <div class="small-note">${parts.map(p => `${esc(fmt.percent(p.rate, 0))} — ${esc(fmt.money(p.amount))}`).join(' · ')}</div></td>`;
  };

  const mergeParts = list => {
    const by = new Map();
    for (const p of list) by.set(p.rate, (by.get(p.rate) ?? 0) + p.amount);
    return [...by].sort((a, b) => a[0] - b[0]).map(([rate, amount]) => ({ rate, amount }));
  };

  let gTotal = 0; let tTotal = 0; let nTotal = 0; let vacTotal = 0;
  const bySlotTotal = new Map();
  const body = [...months.entries()].sort().map(([m, list]) => {
    const gross = list.reduce((s, r) => s + (r.income.gross ?? 0), 0);
    const tax = list.reduce((s, r) => s + (r.income.tax ?? 0), 0);
    const net = list.reduce((s, r) => s + r.totalIncome, 0);
    const parts = mergeParts(list.flatMap(r => r.income.taxParts ?? []));
    gTotal += gross; tTotal += tax; nTotal += net;
    vacTotal += list.reduce((s, r) => s + (r.income.vacationPay ?? 0), 0);
    const note = list.map(r => `${esc((r.period.title || 'выплата').toLowerCase())} ${esc(fmt.date(r.period.pay_date, 'dayMonth'))} · ${esc(fmt.money(r.totalIncome))}`).join('; ');
    const cells = slots.map(o => {
      const own = list.filter(r => r.period.slot_order === o).reduce((s, r) => s + r.totalIncome, 0);
      bySlotTotal.set(o, (bySlotTotal.get(o) ?? 0) + own);
      return `<td class="num">${own ? esc(fmt.money(own)) : ''}</td>`;
    }).join('');
    return `<tr>
      <td><b>${esc(fmt.month(m, { withYear: false }))}</b><div class="small-note">${note}</div></td>
      ${cells}
      <td class="num">${esc(fmt.money(gross))}</td>
      ${rateCell(parts)}
      <td class="num">${esc(fmt.money(tax))}</td>
      <td class="num"><b>${esc(fmt.money(net))}</b></td>
    </tr>`;
  });

  const allParts = mergeParts(rows.flatMap(r => r.income.taxParts ?? []));
  const foot = `<tr>
    <td><b>Итого за год</b>${vacTotal ? `<div class="small-note">в том числе отпускные ${esc(fmt.money(vacTotal))}</div>` : ''}</td>
    ${slots.map(o => `<td class="num">${esc(fmt.money(bySlotTotal.get(o) ?? 0))}</td>`).join('')}
    <td class="num">${esc(fmt.money(gTotal))}</td>
    ${rateCell(allParts)}
    <td class="num">${esc(fmt.money(tTotal))}</td>
    <td class="num"><b>${esc(fmt.money(nTotal))}</b></td>
  </tr>`;

  return card({
    title: `Доход по месяцам ${year}`,
    note: 'Месяц — расчётный период: аванс приходит в нём, зарплата за него — в следующем. '
      + 'Начислено и налог считаются нарастающим итогом за календарный год выплаты.',
    body: body.length
      ? table({
        head: ['Месяц', ...slots.map(o => ({ title: slotTitle(o), cls: 'num' })),
          { title: 'Начислено', cls: 'num' }, { title: 'Ставка', cls: 'num' },
          { title: 'Налог', cls: 'num' }, { title: 'На руки', cls: 'num' }],
        rows: body, foot,
      })
      : '<div class="muted">Выплат в этом году нет.</div>',
  });
}

/* ------------------------------------------------------ расходы за год */

function expensesView(ctx, rows) {
  const { fmt, state, year } = ctx;
  const cats = state.expenses?.expense_categories ?? [];
  const facts = (state.facts?.expense_facts ?? []).filter(f => String(f.ym).startsWith(String(year)));

  const plan = new Map();
  for (const r of rows) for (const c of r.expenses.categories) plan.set(c.category_id, (plan.get(c.category_id) ?? 0) + c.amount);
  const fact = new Map();
  for (const f of facts) fact.set(f.category_id, (fact.get(f.category_id) ?? 0) + (Number(f.amount) || 0));

  const installments = rows.reduce((s, r) => s + r.installmentsTotal, 0);
  const cards = rows.reduce((s, r) => s + sumOf(r.debtPayments), 0);
  const catPlan = [...plan.values()].reduce((s, x) => s + x, 0);
  const catFact = [...fact.values()].reduce((s, x) => s + x, 0);

  const spends = new Map();
  for (const t of state.savings?.goal_transactions ?? []) {
    if (t.kind !== 'spend' || !String(t.date ?? '').startsWith(String(year))) continue;
    spends.set(t.goal_id, (spends.get(t.goal_id) ?? 0) + (Number(t.amount) || 0));
  }
  const goalsById = new Map((state.savings?.goals ?? []).map(g => [g.id, g]));
  const goalSpend = [...spends.values()].reduce((s, x) => s + x, 0);

  const grand = catPlan + installments + cards + goalSpend;
  const share = v => (!grand ? '' : v / grand < 0.005 ? '< 1%' : fmt.percent(v / grand * 100, 0));

  const catRows = cats.slice().sort((a, b) => (plan.get(b.id) ?? 0) - (plan.get(a.id) ?? 0)).map(c => {
    const p = plan.get(c.id) ?? 0;
    const f = fact.get(c.id) ?? 0;
    if (!p && !f) return '';
    const diff = f - p;
    return `<tr>
      <td>${esc(c.title)}</td><td class="num muted">${esc(share(p))}</td>
      <td class="num">${esc(fmt.money(p))}</td><td class="num">${esc(fmt.money(f))}</td>
      <td class="num" style="${diff > 0 ? 'color:var(--danger);' : diff < 0 ? 'color:var(--good);' : ''}">${f ? esc(fmt.money(diff, undefined, { sign: true })) : ''}</td>
    </tr>`;
  }).filter(Boolean);

  const byInstallment = new Map();
  for (const r of rows) for (const x of r.installments) for (const id of x.installments) {
    byInstallment.set(id, (byInstallment.get(id) ?? 0) + x.amount / x.installments.length);
  }
  const byCard = new Map();
  for (const r of rows) for (const [id, v] of Object.entries(r.debtPayments ?? {})) byCard.set(id, (byCard.get(id) ?? 0) + v);
  const instTitles = new Map((state.debts?.installments ?? []).map(i => [i.id, i.title]));
  const cardTitles = new Map((state.debts?.credit_cards ?? []).map(c => [c.id, c.title]));
  const debtLine = (name, v) => `<tr><td>${esc(name)}</td><td class="num muted">${esc(share(v))}</td><td class="num">${esc(fmt.money(v))}</td></tr>`;
  const debtRows = [
    ...[...byInstallment.entries()].sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v > 0.5).map(([id, v]) => debtLine(`${instTitles.get(id) ?? id} · рассрочка`, v)),
    ...[...byCard.entries()].sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v > 0.5).map(([id, v]) => debtLine(`${cardTitles.get(id) ?? id} · кредитка`, v)),
  ];

  const goalRows = [...spends.entries()].sort((a, b) => b[1] - a[1])
    .map(([id, v]) => `<tr><td>${esc(goalsById.get(id)?.title ?? id)}</td><td class="num muted">${esc(share(v))}</td><td class="num">${esc(fmt.money(v))}</td></tr>`);

  /* Долги и траты из копилок: «что — доля — сумма» */
  const section = (heading, note, unit, body_, totalValue) => (body_.length ? `
    <h3 style="margin:18px 0 6px;font-size:15px;">${esc(heading)}</h3>
    ${note ? `<div class="small-note" style="margin-bottom:8px;">${esc(note)}</div>` : ''}
    ${table({
      head: [unit, { title: 'Доля', cls: 'num' }, { title: 'За год', cls: 'num' }],
      rows: body_,
      foot: `<tr><td><b>Итого</b></td><td class="num muted">${esc(share(totalValue))}</td>
        <td class="num"><b>${esc(fmt.money(totalValue))}</b></td></tr>`,
    })}` : '');

  return card({
    title: `Расходы за ${year} год`,
    body: `<div class="info-box" style="margin-bottom:6px;">В плитке «Расходы за год» учтены категории, платежи по рассрочкам
        и погашение кредиток — всё, что уходит из выплат. Траты из копилок показаны отдельно: это деньги,
        отложенные в прошлых выплатах, поэтому в плитку они не входят.</div>
      ${catRows.length ? `<h3 style="margin:18px 0 6px;font-size:15px;">Категории</h3>
        <div class="small-note" style="margin-bottom:8px;">План — то, что заложено в выплаты этого года, вместе с ручными правками.
          Факт берётся из раздела «Расходы».</div>
        ${table({ head: ['Категория', { title: 'Доля', cls: 'num' }, { title: 'План за год', cls: 'num' },
          { title: 'Факт за год', cls: 'num' }, { title: 'Разница', cls: 'num' }],
          rows: catRows,
          foot: `<tr><td><b>Итого</b></td><td class="num muted">${esc(share(catPlan))}</td>
            <td class="num"><b>${esc(fmt.money(catPlan))}</b></td><td class="num"><b>${esc(fmt.money(catFact))}</b></td>
            <td class="num">${catFact ? esc(fmt.money(catFact - catPlan, undefined, { sign: true })) : ''}</td></tr>` })}` : ''}
      ${section('Долги', '', 'Что', debtRows, installments + cards)}
      ${section('Траты из копилок', 'Деньги, которые вы взяли из целей: переводы между копилками здесь не считаются.',
        'Копилка', goalRows, goalSpend)}
      <div class="row between" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);">
        <b>Всего расходов и трат за год, включая копилки</b><b>${esc(fmt.money(grand))}</b></div>`,
  });
}

/* --------------------------------------------------- отложено в цели */

/* Год, к которому относится этап: срок, а если его нет — прогноз накопления.
   null — этап не достигается в плане, показываем его в любом году. */
function milestoneYear(m, done, planStartYear) {
  if (m.deadline) return Number(m.deadline.slice(0, 4));
  if (done === 'pre') return planStartYear;
  if (done) return Number(String(done).slice(0, 4));
  return null;
}

/* Карточка цели в разрезе года: что было на начало, сколько отложим, что выйдет */
function yearGoalCard(ctx, g, allocated, { withStages, extra = '' }) {
  const { fmt, state, sim, year } = ctx;
  const txs = state.savings?.goal_transactions ?? [];
  const planStartYear = sim.rows.length ? Number(sim.rows[0].period.pay_date.slice(0, 4)) : year;

  const total = goalTotal(g, state.savings?.goal_milestones ?? []) || (Number(g.target_amount) || 0);
  const base = goalBalanceAt(sim, g, txs, `${year - 1}-12-31`);
  const added = allocated.get(g.id) ?? 0;
  const end = base + added;
  const pct = v => (total > 0 ? Math.max(0, Math.min(100, Math.round(v / total * 100))) : 0);

  const list = sim.milestonesOf(g);
  const dates = sim.milestoneDates[g.id] ?? [];
  const mine = withStages
    ? list.map((m, i) => ({ m, done: dates[i] }))
      .filter(({ m, done }) => { const y = milestoneYear(m, done, planStartYear); return y === null || y === year; })
    : [];

  const stages = mine.map(({ m, done }) => {
    const label = !done ? (m.deadline ? `не достигается к ${fmt.date(m.deadline)}` : 'не достигается в плане')
      : done === 'pre' ? 'уже накоплено'
      : m.deadline ? (done <= m.deadline ? `в графике (к ${fmt.date(done)})` : `позже срока (к ${fmt.date(done)})`)
      : `прогноз: к ${fmt.date(done)}`;
    const cls = !done ? 'danger' : (!m.deadline || done === 'pre' || done <= m.deadline) ? 'ok' : 'warn';
    return `<div class="row between" style="gap:8px;">
      <span>${esc(m.title || 'Этап')} · ${esc(fmt.money(m.target, g.currency_code))}</span>${pill(label, cls)}</div>`;
  }).join('');

  const done = total > 0 && end >= total - 0.5;
  const head = g.completed ? pill('закрыта', 'ok')
    : done ? pill('накоплена', 'ok')
    : added > 0.5 ? pill(`+${fmt.money(added, g.currency_code)} за год`)
    : pill('в этом году не пополняется', 'warn');

  return `<div class="card goal-card">
    <div class="row between"><h3>${esc(g.title)}</h3>${head}</div>
    ${total > 0
      ? `<div class="progress"><i class="year-start" style="width:${pct(base)}%"></i><i style="width:${pct(end)}%"></i></div>
         <div class="small-note">на начало ${year}: ${esc(fmt.money(base, g.currency_code))} ·
           за год ${added > 0.5 ? '+' : ''}${esc(fmt.money(added, g.currency_code))} ·
           на конец ${year}: <b>${esc(fmt.money(end, g.currency_code))}</b> из ${esc(fmt.money(total, g.currency_code))}</div>`
      : `<div class="small-note">на начало ${year}: ${esc(fmt.money(base, g.currency_code))} ·
           за год ${added > 0.5 ? '+' : ''}${esc(fmt.money(added, g.currency_code))} ·
           на конец ${year}: <b>${esc(fmt.money(end, g.currency_code))}</b>. Сумма цели не задана.</div>`}
    ${stages ? `<div style="margin-top:10px;display:grid;gap:6px;">${stages}</div>`
      : withStages ? `<div class="small-note" style="margin-top:10px;">В ${year} году ничего не закрывается — копим дальше.</div>` : ''}
    ${extra ? `<div style="margin-top:12px;">${extra}</div>` : ''}
  </div>`;
}

function savedView(ctx) {
  const { state, sim, year } = ctx;
  const rows = sim.rows.filter(r => Number(r.period.year) === year);
  const allocated = new Map();
  for (const r of rows) for (const [id, v] of Object.entries(r.allocations ?? {})) allocated.set(id, (allocated.get(id) ?? 0) + v);

  const all = (state.savings?.goals ?? []).slice().sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const of = kind => all.filter(g => g.kind_code === kind);

  const section = (heading, list, opts) => (list.length ? `
    <h3 style="margin:22px 0 0;font-size:16px;">${esc(heading)}</h3>
    <div class="grid cols-2">${list.map(g => yearGoalCard(ctx, g, allocated, opts)).join('')}</div>` : '');

  if (!all.length) return card({ title: 'Цели', body: '<div class="muted">Целей пока нет — заведите их на вкладке «Копилки».</div>' });

  const gifts = of('gifts').map(g => `<div class="card goal-card">
    <div class="row between" style="margin-bottom:12px;"><h3>${esc(g.title)}</h3></div>
    ${giftPlanTable(ctx, g, { savedThisYear: allocated.get(g.id) ?? 0 })}
  </div>`).join('');

  return `
    ${section('Копилки', of('bucket'), { withStages: true })}
    ${section('Подушки', of('reserve'), { withStages: false })}
    ${gifts}`;
}

/* ------------------------------------------------------------------ экран */

export function render(ctx) {
  const { sim, fmt, year, state, ui } = ctx;
  const rows = sim.rows.filter(r => Number(r.period.year) === year);
  const sum = fn => rows.reduce((s, r) => s + fn(r), 0);
  const income = sum(r => r.totalIncome);
  const expenses = sum(r => r.categoriesTotal + r.installmentsTotal + sumOf(r.debtPayments));
  const saved = sum(r => sumOf(r.allocations));
  const free = sum(r => Math.max(0, r.unallocated));
  const deficit = rows.filter(r => r.unallocated < -0.5).length;

  const view = VIEWS.includes(ui.draft.dashboard?.view) ? ui.draft.dashboard.view : 'income';
  const tile = (key, label, value) => (key
    ? `<button class="card stat switch${view === key ? ' active' : ''}" data-ov="${key}">
        <div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></button>`
    : `<div class="card stat"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`);

  const checks = sim.monthChecks.filter(c => c.shortfall > 0.5 && String(c.month).startsWith(String(year)));
  const checkRows = checks.map(c => `<tr>
    <td>${esc(fmt.month(c.month))}</td>
    <td>${esc((state.expenses?.expense_categories ?? []).find(x => x.id === c.category_id)?.title ?? c.category_id)}</td>
    <td class="num">${esc(fmt.money(c.collected))}</td>
    <td class="num">${esc(fmt.money(c.plan))}</td>
    <td class="num">${esc(fmt.percent(c.missingPercent, 1))}</td></tr>`);
  const warn = [...new Set(sim.warnings.map(w => w.code))];

  const body = view === 'income' ? incomeView(ctx, rows)
    : view === 'expenses' ? expensesView(ctx, rows)
    : savedView(ctx);

  return `
    <h2 style="margin:0;">${year} год</h2>
    <div class="grid cols-4">
      ${tile('income', 'Доход за год', fmt.money(income))}
      ${tile('expenses', 'Расходы за год', fmt.money(expenses))}
      ${tile('saved', 'Отложено в цели', fmt.money(saved))}
      ${tile(null, 'Свободный остаток', fmt.money(free))}
    </div>
    <div class="row wrap" style="gap:8px;">
      ${pill(`${rows.length} выплат в ${year} году`)}
      ${deficit ? pill(`${deficit} ${fmt.plural(deficit, { one: 'выплата', few: 'выплаты', many: 'выплат' })} с дефицитом`, 'danger') : pill('дефицитных выплат нет', 'ok')}
    </div>
    ${body}
    ${checks.length ? card({
      title: 'Процентные категории: недобор за месяц',
      note: 'За месяц процент должен покрыть план категории. Здесь — месяцы, где не покрыл.',
      body: table({ head: ['Месяц', 'Категория', { title: 'Собрано', cls: 'num' }, { title: 'План', cls: 'num' }, { title: 'Не хватает процента', cls: 'num' }], rows: checkRows }),
    }) : ''}
    ${warn.length ? card({ title: 'Предупреждения расчёта', body: `<ul class="small-note">${warn.map(w => `<li>${esc(WARNINGS[w] ?? w)}</li>`).join('')}</ul>` }) : ''}`;
}

export function handle(ev, ctx) {
  const btn = ev.target.closest('[data-ov]');
  if (!btn) return false;
  (ctx.ui.draft.dashboard ?? (ctx.ui.draft.dashboard = {})).view = btn.dataset.ov;
  return true;
}
