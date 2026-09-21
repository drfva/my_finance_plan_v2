/* ---------------------------------------------------------------------
   tour.js — подсказки для первого входа.

   Показываются, пока в плане нет ни графика выплат, ни самих выплат: панель
   в углу экрана ведёт по шагам — где ваш план и какие ещё вам открыты, оклад,
   налог, год и график, создание выплат. Каждый шаг знает, выполнен ли он, и
   умеет открыть нужный раздел. Подсказки можно пропустить в любой момент;
   отказ запоминается в браузере, в базе для этого ничего не заводится.
--------------------------------------------------------------------- */

import { esc, button } from './dom.js';

const KEY = 'fin-tour-off';

const store = {
  off(accountId) {
    try { return (localStorage.getItem(KEY) || '').split(',').includes(String(accountId)); } catch (e) { return false; }
  },
  skip(accountId) {
    try {
      const list = (localStorage.getItem(KEY) || '').split(',').filter(Boolean);
      if (!list.includes(String(accountId))) list.push(String(accountId));
      localStorage.setItem(KEY, list.join(','));
    } catch (e) { /* приватный режим: подсказки вернутся в следующий раз */ }
  },
};

/* Шаги: done — выполнен ли, go — куда ведёт кнопка */
function steps(ctx) {
  const inc = ctx.state.income ?? {};
  const others = (ctx.state.accounts ?? []).filter(a => a.id !== ctx.state.account?.id);
  return [
    {
      code: 'plan',
      title: 'Это ваш план',
      text: others.length
        ? `Сейчас открыт «${ctx.state.account?.title ?? 'план'}». Вам открыты и другие планы: ${others.map(a => a.title).join(', ')}.
           Переключиться между ними можно в Настройках, в разделе «План» — там же меняется название.`
        : `Сейчас открыт «${ctx.state.account?.title ?? 'план'}» — он ваш, вы его владелец.
           Название меняется в Настройках, в разделе «План» — там же есть кнопка «Заполнить пример плана»,
           если хочется сначала посмотреть, как всё считается. Если вам откроют чужой план, в этом разделе появится переключатель.`,
      go: { tab: 'settings', open: 'set:plan' },
      action: 'Открыть раздел «План»',
      done: true,
    },
    {
      code: 'salary',
      title: 'Внесите оклад',
      text: `С какой даты действует оклад и сколько он. Из него считается доход каждой выплаты: стоимость отработанного дня —
        оклад ÷ рабочие дни месяца. Если дохода по окладу нет, шаг можно пропустить и вписывать суммы выплат руками.`,
      go: { tab: 'settings', open: 'set:salary' },
      action: 'Открыть раздел «Оклад»',
      done: (inc.salary_rates ?? []).length > 0,
    },
    {
      code: 'tax',
      title: 'Проверьте налог',
      text: `Шкала налога: ступени дохода и ставки. Нужна, чтобы из оклада получилась сумма на руки.
        Если налог не удерживается, шаг можно пропустить — тогда доход считается без него.`,
      go: { tab: 'settings', open: 'set:tax' },
      action: 'Открыть раздел «Налог»',
      done: (inc.tax_scales ?? []).length > 0,
    },
    {
      code: 'schedule',
      title: 'Заведите год и график выплат',
      text: `Год плана и числа, когда приходят деньги: например, аванс 20-го за 1–15 и зарплата 5-го следующего месяца за 16–31.
        График — основа всего расчёта: по нему создаются выплаты.`,
      go: { tab: 'settings', open: 'set:years' },
      action: 'Открыть «Годы плана и график»',
      done: (inc.payout_slots ?? []).length > 0,
    },
    {
      code: 'periods',
      title: 'Создайте выплаты',
      text: `В том же разделе под графиком есть кнопка «Создать выплаты N года» — она разложит год по датам и посчитает доход.
        После этого появятся вкладка «Доходы» и весь расчёт.`,
      go: { tab: 'settings', open: 'set:years' },
      action: 'Создать выплаты',
      done: (inc.periods ?? []).length > 0,
    },
    {
      code: 'done',
      title: 'Готово',
      text: `План считается. Дальше по желанию: категории расходов, копилки и подушки, кредитки и рассрочки, праздники на вкладке «Подарки».
        Всё это можно добавлять постепенно — расчёт обновляется сам.`,
      go: { tab: 'dashboard' },
      action: 'Открыть обзор',
      done: true,
    },
  ];
}

/* Нужны ли подсказки: план пустой, права на правку есть, отказа не было */
export function tourNeeded(ctx) {
  if (!ctx.canEdit) return false;
  const inc = ctx.state.income ?? {};
  if ((inc.periods ?? []).length || (inc.payout_slots ?? []).length) return false;
  return !store.off(ctx.state.account?.id);
}

export function tourPanel(ctx) {
  const list = steps(ctx);
  const draft = ctx.ui.draft.tour ?? (ctx.ui.draft.tour = {});
  /* Первый заход — начинаем со знакомства с планом. Если что-то уже заполнено,
     подсказка сама встаёт на первый невыполненный шаг. Вручную можно ходить свободно. */
  const started = list.some(x => x.code !== 'plan' && x.code !== 'done' && x.done);
  const auto = started ? Math.max(0, list.findIndex(x => !x.done)) : 0;
  const i = Math.min(list.length - 1, Math.max(0, draft.step ?? auto));
  const s = list[i];

  return `<div class="tour">
    <div class="row between" style="gap:10px;">
      <b>Шаг ${i + 1} из ${list.length}</b>
      <button class="ghost small" data-tour="skip" title="Больше не показывать">✕</button>
    </div>
    <div class="tour-dots">${list.map((x, k) => `<i class="${k === i ? 'now' : ''}${x.done ? ' done' : ''}"></i>`).join('')}</div>
    <h3 style="margin:8px 0 4px;">${esc(s.title)}${s.done && s.code !== 'plan' && s.code !== 'done' ? ' ✓' : ''}</h3>
    <div class="small-note" style="margin-top:0;">${s.text}</div>
    <div class="row wrap" style="gap:8px;margin-top:12px;">
      ${button({ action: 'tour', value: `go:${i}`, label: s.action, cls: 'primary small' })}
      ${i > 0 ? button({ action: 'tour', value: `back:${i}`, label: 'Назад', cls: 'ghost small' }) : ''}
      ${i < list.length - 1
        ? button({ action: 'tour', value: `next:${i}`, label: 'Дальше', cls: 'ghost small' })
        : button({ action: 'tour', value: 'skip', label: 'Закончить', cls: 'ghost small' })}
    </div>
  </div>`;
}

/* Возвращает true, если экран нужно перерисовать */
export function tourHandle(ev, ctx) {
  const el = ev.target.closest('[data-tour]');
  if (!el) return false;
  const [what, idx] = el.dataset.tour.split(':');
  const draft = ctx.ui.draft.tour ?? (ctx.ui.draft.tour = {});
  const list = steps(ctx);

  if (what === 'skip') { store.skip(ctx.state.account?.id); draft.step = null; return true; }
  if (what === 'next') { draft.step = Math.min(list.length - 1, Number(idx) + 1); return true; }
  if (what === 'back') { draft.step = Math.max(0, Number(idx) - 1); return true; }
  if (what === 'go') {
    const step = list[Number(idx)];
    draft.step = Number(idx);
    ctx.ui.tab = step.go.tab;
    if (step.go.open) ctx.ui.open.add(step.go.open);
    return true;
  }
  return false;
}
