/* Прогон всех кейсов траты/перевода в копилке через настоящий трекер:
   tools/cases/build.mjs > tools/cases/index.html */
import { createTracker } from '../../src/engine/savings.js';

const money = n => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
const d = s => s.slice(8, 10) + '.' + s.slice(5, 7);

/* Прогоняем сценарий по шагам и снимаем состояние после каждого */
function run({ milestones, start = 0, events, today = '' }) {
  const goals = [{ id: 'g', title: 'Копилка', starting_balance: start }];
  const ms = milestones.map((m, i) => ({ id: `m${i}`, goal_id: 'g', ...m }));
  const t = createTracker({ goals, milestones: ms, today });
  const snap = title => ({
    title,
    balance: t.balance('g'),
    phase: t.phase('g'),
    dates: t.milestoneDates().g,
    funded: t.milestoneFunded().g,
  });
  const steps = [snap(start ? `начальный остаток ${money(start)}` : 'старт')];
  for (const e of events) {
    t.apply({ goal_id: 'g', date: e.date, amount: e.amount, kind: e.kind, milestone_id: e.ms != null ? `m${e.ms}` : null });
    steps.push({ ...snap(e.title), date: e.date, kind: e.kind, amount: e.amount });
  }
  return { milestones: ms, steps };
}

const KIND = { transfer_in: 'перевод в копилку', deposit: 'пополнение', spend: 'трата', transfer_out: 'перевод из копилки' };

const CASES = [
  {
    id: 1, title: 'Пополнение закрывает этап',
    note: 'Денег хватило — этап закрыт датой пополнения, остаток идёт в прогресс следующего.',
    milestones: [{ target: 10000, deadline: '2027-10-05' }, { target: 20000, deadline: '2027-12-01' }],
    events: [{ date: '2027-10-01', amount: 15000, kind: 'transfer_in', title: 'перевод 15 000' }],
  },
  {
    id: 2, title: 'Трата до срока этапа — этап открывается заново',
    note: 'Ваш пример: перевод 10 000 01.10, этап 05.10 на 10 000, трата 5 000 04.10. На 05.10 в копилке 5 000 — этап не успевает.',
    milestones: [{ target: 10000, deadline: '2027-10-05' }],
    events: [
      { date: '2027-10-01', amount: 10000, kind: 'transfer_in', title: 'перевод 10 000' },
      { date: '2027-10-04', amount: 5000, kind: 'spend', title: 'трата 5 000' },
    ],
  },
  {
    id: 3, title: 'Трата после срока — этап засчитан навсегда',
    note: 'Тот же этап со сроком 03.10. К сроку деньги были — этап закрыт, история не меняется. Трата 04.10 просто уносит его резерв.',
    milestones: [{ target: 10000, deadline: '2027-10-03' }],
    events: [
      { date: '2027-10-01', amount: 10000, kind: 'transfer_in', title: 'перевод 10 000' },
      { date: '2027-10-04', amount: 5000, kind: 'spend', title: 'трата 5 000' },
    ],
  },
  {
    id: 4, title: 'Трата задним числом, до срока — этап открывается',
    note: 'Срок 03.10, трата поставлена на 02.10. На 03.10 в копилке было 5 000 — значит этап не был накоплен.',
    milestones: [{ target: 10000, deadline: '2027-10-03' }],
    events: [
      { date: '2027-10-01', amount: 10000, kind: 'transfer_in', title: 'перевод 10 000' },
      { date: '2027-10-02', amount: 5000, kind: 'spend', title: 'трата 5 000 (задним числом)' },
    ],
  },
  {
    id: 5, title: 'Перевод из копилки = трата',
    note: 'Вид оттока роли не играет: важна только дата относительно срока этапа. Сравните с кейсом 2 — результат тот же.',
    milestones: [{ target: 10000, deadline: '2027-10-05' }],
    events: [
      { date: '2027-10-01', amount: 10000, kind: 'transfer_in', title: 'перевод 10 000' },
      { date: '2027-10-04', amount: 5000, kind: 'transfer_out', title: 'перевод в другую копилку 5 000' },
    ],
  },
  {
    id: 6, title: 'Трата берёт накопленное на прошедший этап',
    note: 'Срок первого этапа позади, его 10 000 лежат в копилке — трата берёт их, а прогресс второго этапа остаётся нетронутым.',
    milestones: [{ target: 10000, deadline: '2027-10-03' }, { target: 10000, deadline: '2027-12-01' }],
    events: [
      { date: '2027-10-01', amount: 16000, kind: 'transfer_in', title: 'перевод 16 000' },
      { date: '2027-10-10', amount: 4000, kind: 'spend', title: 'трата 4 000' },
    ],
  },
  {
    id: 7, title: 'Трата больше, чем накоплено на прошедший этап',
    note: 'Сначала уходят 10 000 первого этапа (срок 03.10 позади, этап остаётся закрытым), и только оставшиеся 2 000 — из прогресса второго.',
    milestones: [{ target: 10000, deadline: '2027-10-03' }, { target: 10000, deadline: '2027-12-01' }],
    events: [
      { date: '2027-10-01', amount: 16000, kind: 'transfer_in', title: 'перевод 16 000' },
      { date: '2027-10-10', amount: 12000, kind: 'spend', title: 'трата 12 000' },
    ],
  },
  {
    id: 8, title: 'Откат двух этапов подряд',
    note: 'Оба срока впереди. Отток открывает сначала второй этап, потом первый; остаток денег становится прогрессом первого.',
    milestones: [{ target: 10000, deadline: '2027-11-01' }, { target: 10000, deadline: '2027-12-01' }],
    events: [
      { date: '2027-10-01', amount: 20000, kind: 'transfer_in', title: 'перевод 20 000' },
      { date: '2027-10-10', amount: 17000, kind: 'spend', title: 'трата 17 000' },
    ],
  },
  {
    id: 9, title: 'Смешанный: один срок прошёл, другой впереди',
    note: 'Сначала тратятся 10 000 первого этапа — его срок 03.10 позади. Оставшихся 5 000 не хватает второму этапу: его срок 01.12 впереди, поэтому он откатывается.',
    milestones: [{ target: 10000, deadline: '2027-10-03' }, { target: 10000, deadline: '2027-12-01' }],
    events: [
      { date: '2027-10-01', amount: 20000, kind: 'transfer_in', title: 'перевод 20 000' },
      { date: '2027-10-10', amount: 15000, kind: 'spend', title: 'трата 15 000' },
    ],
  },
  {
    id: 10, title: 'Этап без срока откатывается всегда',
    note: 'У этапа без срока дата закрытия — прогноз. Любой отток, который до него дотянулся, открывает его заново.',
    milestones: [{ target: 10000, deadline: null }],
    events: [
      { date: '2027-10-01', amount: 10000, kind: 'transfer_in', title: 'перевод 10 000' },
      { date: '2027-12-31', amount: 4000, kind: 'spend', title: 'трата 4 000' },
    ],
  },
  {
    id: 11, title: 'Начальный остаток копилки',
    note: 'Остаток закрывает этапы сразу на старте плана («уже накоплено»). Дальше он живёт по общим правилам: трата до срока откатывает этап.',
    start: 12000,
    milestones: [{ target: 10000, deadline: '2027-11-01' }],
    events: [{ date: '2027-10-10', amount: 5000, kind: 'spend', title: 'трата 5 000' }],
  },
  {
    id: 12, title: 'Пополнение после отката закрывает этап заново',
    note: 'Дата закрытия — дата последнего пополнения, которого хватило. Если она позже срока, в интерфейсе будет «позже срока».',
    milestones: [{ target: 10000, deadline: '2027-11-01' }],
    events: [
      { date: '2027-10-01', amount: 10000, kind: 'transfer_in', title: 'перевод 10 000' },
      { date: '2027-10-10', amount: 6000, kind: 'spend', title: 'трата 6 000' },
      { date: '2027-10-25', amount: 6000, kind: 'transfer_in', title: 'перевод 6 000' },
    ],
  },
  {
    id: 13, title: 'Трата больше, чем в копилке',
    note: 'Баланс уходит в минус — так видно, что трату нечем покрыть. Следующее пополнение сначала закрывает этот минус и только потом идёт в прогресс этапа.',
    milestones: [{ target: 10000, deadline: '2027-11-01' }],
    events: [
      { date: '2027-10-01', amount: 10000, kind: 'transfer_in', title: 'перевод 10 000' },
      { date: '2027-10-10', amount: 14000, kind: 'spend', title: 'трата 14 000' },
      { date: '2027-10-20', amount: 6000, kind: 'transfer_in', title: 'перевод 6 000' },
    ],
  },
  {
    id: 14, title: 'Лечение: сроки этапов позади',
    note: 'Сегодня 23.09.2026, сроки первых трёх этапов позади — накопленное на них можно тратить. Трата 42 853 берёт его с самого раннего непотраченного этапа («Химия»), ничего не откатывая: прогресс будущей «Операции» — 36 000 — остаётся.',
    milestones: [
      { target: 20845, deadline: '2026-08-25', title: 'Анализы+КТ' },
      { target: 42853, deadline: '2026-09-05', title: 'Химия' },
      { target: 25000, deadline: '2026-09-20', title: 'Химия+КТ' },
      { target: 40000, deadline: '2027-02-01', title: 'Операция' },
    ],
    events: [
      { date: '2026-08-20', amount: 20845, kind: 'deposit', title: 'отчисление 20 845' },
      { date: '2026-08-30', amount: 20845, kind: 'spend', title: 'ветеринар 20 845' },
      { date: '2026-09-04', amount: 42853, kind: 'deposit', title: 'отчисление 42 853' },
      { date: '2026-09-18', amount: 61000, kind: 'deposit', title: 'отчисление 61 000' },
      { date: '2026-09-19', amount: 42853, kind: 'spend', title: 'ветеринар+химия 42 853' },
    ],
  },
];

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function cellFor(c, i, step) {
  const done = step.dates[i];
  const funded = step.funded[i];
  if (!done) {
    const current = step.phase.idx === i;
    const saved = current ? step.phase.saved : 0;
    return `<td class="open"><b>открыт</b><span>${current ? `набрано ${money(saved)} из ${money(c.target)}` : `ждёт очереди`}</span></td>`;
  }
  const late = c.deadline && done !== 'pre' && done > c.deadline;
  return `<td class="${late ? 'late' : 'closed'}"><b>закрыт ${done === 'pre' ? 'на старте' : d(done)}</b><span>${
    funded > 0.0001 ? `резерв ${money(funded)}` : 'резерв потрачен'}</span></td>`;
}

function caseHtml(cs) {
  const { milestones, steps } = run({ today: '2026-09-23', ...cs });
  const head = milestones.map((m, i) => `<th>${m.title ? esc(m.title) : `Этап ${i + 1}`}<span>${money(m.target)}${m.deadline ? ` · до ${d(m.deadline)}` : ' · без срока'}</span></th>`).join('');
  const rows = steps.map(s => `<tr>
      <td class="ev">${s.date ? `<b>${d(s.date)}</b> ` : ''}${esc(s.title)}${s.kind ? `<span>${KIND[s.kind]}</span>` : ''}</td>
      <td class="bal ${s.balance < 0 ? 'neg' : ''}">${money(s.balance)}</td>
      ${milestones.map((m, i) => cellFor(m, i, s)).join('')}
    </tr>`).join('');
  return `<section class="case">
    <h2><span class="num">${cs.id}</span>${esc(cs.title)}</h2>
    <p class="note">${esc(cs.note)}</p>
    <div class="scroll"><table>
      <thead><tr><th>Событие</th><th>В копилке</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Копилки: траты и переводы</title>
<style>
  :root{--bg:#0f1115;--surface:#171a21;--surface-2:#1e222b;--text:#e7e9ee;--muted:#9aa3b2;--line:#2a2f3a;
        --ok:#3ecf8e;--warn:#e0a458;--bad:#e06c75;--accent:#7aa2f7}
  @media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f7f9;--surface:#fff;--surface-2:#f0f2f6;
        --text:#1b1f27;--muted:#6b7482;--line:#e2e6ec;--ok:#12855c;--warn:#a96a12;--bad:#c0392b;--accent:#2f6fd0}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1040px;margin:0 auto;padding:32px 16px 64px}
  h1{font-size:26px;margin:0 0 6px}
  .lead{color:var(--muted);margin:0 0 24px;max-width:70ch}
  .rules{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 28px}
  .rules ol{margin:8px 0 0;padding-left:20px}
  .rules li{margin:6px 0}
  .case{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 18px}
  h2{font-size:17px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
  .num{flex:none;width:26px;height:26px;border-radius:8px;background:var(--surface-2);color:var(--accent);
       font-size:13px;display:grid;place-items:center}
  .note{color:var(--muted);margin:0 0 14px;font-size:14px}
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{border-collapse:collapse;width:100%;min-width:560px;font-size:14px}
  th,td{text-align:left;padding:9px 10px;border-top:1px solid var(--line);vertical-align:top}
  thead th{border-top:0;color:var(--muted);font-weight:600;font-size:13px}
  thead th span{display:block;font-weight:400;color:var(--muted);opacity:.8;font-size:12px}
  td span{display:block;color:var(--muted);font-size:12px}
  td.ev{min-width:190px}
  td.bal{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
  td.bal.neg{color:var(--bad)}
  td.closed b{color:var(--ok)} td.late b{color:var(--warn)} td.open b{color:var(--muted);font-weight:600}
  tbody tr:first-child td{color:var(--muted)}
  footer{color:var(--muted);font-size:13px;margin-top:24px}
</style></head><body><div class="wrap">
<h1>Копилки: как траты и переводы двигают этапы</h1>
<p class="lead">Все цифры ниже посчитаны настоящим движком (<code>createTracker</code> из <code>src/engine/savings.js</code>), а не нарисованы руками. Каждая строка — состояние копилки после очередного события. Все кейсы посчитаны на «сегодня» <b>23.09.2026</b> — это важно для правила о прошедших сроках.</p>
<div class="rules"><b>Правила</b>
<ol>
  <li>Деньги копилки лежат одной суммой. Пополнения её увеличивают, траты и переводы уменьшают — на свою дату.</li>
  <li>Этап закрыт, если на его срок денег хватало. Закрытый этап держит свою сумму в резерве, всё сверх — прогресс следующего этапа.</li>
  <li><b>Прошедший этап</b> — тот, чей срок позади: на дату движения или просто на сегодня. Это история: он был накоплен к сроку и заново не открывается.</li>
  <li>Накопленное на прошедшие этапы — доступный резерв копилки: отток берёт сначала его, с самого раннего этапа, потом прогресс текущего этапа.</li>
  <li>И только потом откатываются закрытые этапы, <b>срок которых ещё впереди</b>: к ним мы ещё идём, и на их дату денег уже не хватит. Будущее прогнозируется от текущей даты, прошлое не пересчитывается.</li>
  <li>Баланс копилки всегда равен сумме резервов закрытых этапов плюс прогресс текущего — пока копилка не ушла в минус.</li>
  <li>Вид оттока — трата или перевод в другую копилку — роли не играет. Важна только дата.</li>
</ol></div>
${CASES.map(caseHtml).join('\n')}
<footer>Сгенерировано <code>tools/cases/build.mjs</code>.</footer>
</div></body></html>`;

process.stdout.write(html);
