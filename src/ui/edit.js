/* ---------------------------------------------------------------------
   edit.js — правка данных прямо в разметке.

   Поле с атрибутами data-edit и data-key само знает, какую строку какой
   таблицы оно меняет, поэтому вкладкам не нужны свои обработчики:

     <input data-edit="income|periods|income_net" data-key='{"id":"2027-01-1"}' data-type="money">
     <button data-add="expenses|expense_categories" data-row='{"title":"Новая"}'>
     <button data-del="expenses|expense_categories" data-key='{"id":"cat-life"}' data-confirm="Удалить категорию?">

   data-type: money, number, int, text, date, monthday, bool, json.
     monthday — одно поле даты пишет день и месяц строки (и год, если праздник разовый). Пустое число — null.
   data-remove-when="0" удаляет строку, когда в поле вписали это значение
   (так работают ручные правки: вернули плановую сумму — правка исчезла).

   Удаление уносит зависимые строки: у категории — её статьи и правки, у цели —
   этапы, циклы, движения и ручные суммы, у года плана — его график и выплаты.
   Иначе база отклонит патч: там те же связи описаны внешними ключами.

   Своя сумма вместо расчёта: вписали отпускные руками — отпуск помечается
   pay_manual, и вернуть расчёт можно ссылкой «подставить по формуле».

   Правка этапа или траты, созданных шаблоном, ставит им user_edited: с этого
   момента повторяющееся накопление и праздники их не перезаписывают.

   Перевод между целями — это пара движений с общим ключом transfer:… . Правка
   даты, суммы или названия одной стороны переносится на вторую, удаление одной
   удаляет обе.
--------------------------------------------------------------------- */

import { rebuildFuture } from '../engine/debts.js';

const DEPENDENTS = {
  'expenses|expense_categories': [
    ['expenses', 'expense_items', 'category_id'],
    ['expenses', 'expense_period_overrides', 'category_id'],
    ['facts', 'expense_facts', 'category_id'],
  ],
  'income|periods': [
    ['expenses', 'expense_period_overrides', 'period_id'],
    ['savings', 'savings_period_overrides', 'period_id'],
    ['debts', 'credit_payment_overrides', 'period_id'],
  ],
  'income|plan_years': [['income', 'payout_slots', 'year']],   // выплаты года уносятся отдельно, вместе с их ручными суммами
  'income|tax_scales': [['income', 'tax_brackets', 'scale_id']],
  'debts|credit_cards': [
    ['debts', 'credit_card_ops', 'card_id'],
    ['debts', 'credit_payment_overrides', 'card_id'],
  ],
  'debts|installments': [['debts', 'installment_payments', 'installment_id']],
  'savings|goals': [
    ['savings', 'goal_milestones', 'goal_id'],
    ['savings', 'goal_cycles', 'goal_id'],
    ['savings', 'goal_transactions', 'goal_id'],
    ['savings', 'savings_period_overrides', 'goal_id'],
    ['gifts', 'gift_events', 'goal_id'],
  ],
  'savings|goal_cycles': [
    ['savings', 'goal_cycle_skips', 'cycle_id'],
    ['savings', 'goal_milestones', 'source_ref'],
    ['savings', 'goal_transactions', 'source_ref'],
  ],
  'gifts|gift_events': [
    ['gifts', 'gift_event_amounts', 'event_id'],
    ['savings', 'goal_milestones', 'source_ref'],
    ['savings', 'goal_transactions', 'source_ref'],
  ],
};

let seq = 0;
export function uid(prefix = 'row') {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

const matches = (row, key) => Object.entries(key).every(([k, v]) => String(row[k]) === String(v));

export function findRow(state, domain, table, key) {
  return (state[domain]?.[table] ?? []).find(r => matches(r, key)) ?? null;
}

export function readValue(el, fmt) {
  const type = el.dataset.type || 'text';
  if (type === 'bool') return el.checked;
  const raw = el.value;
  if (type === 'money' || type === 'number' || type === 'int') {
    if (String(raw).trim() === '') return el.dataset.empty === 'null' ? null : 0;
    const n = type === 'money' ? fmt.parseMoney(raw) : fmt.parseNumber(raw);
    if (n === null) return undefined;                 // не число — значение не меняем
    return type === 'int' ? Math.round(n) : n;
  }
  if (type === 'json') { try { return JSON.parse(raw); } catch { return undefined; } }
  if (type === 'date' || type === 'monthday') return raw || null;
  return raw;
}

/* Записать значение поля в состояние. Возвращает false, если значение не разобрано. */
export function applyEdit(store, el, fmt) {
  const [domain, table, column] = el.dataset.edit.split('|');
  const key = JSON.parse(el.dataset.key || '{}');
  const defaults = JSON.parse(el.dataset.defaults || '{}');
  const value = readValue(el, fmt);
  if (value === undefined) return false;

  store.update(domain, d => {
    const rows = d[table] ?? (d[table] = []);
    let row = rows.find(r => matches(r, key));
    if (!row) {
      if (el.dataset.removeWhen !== undefined && String(value) === el.dataset.removeWhen) return;
      row = { ...key, ...defaults };
      rows.push(row);
    }
    // одно поле даты вместо дня и месяца: у разового праздника запоминаем и год
    if (el.dataset.type === 'monthday') {
      if (!value) return;
      const [y, m, dd] = String(value).split('-').map(Number);
      row.day = dd;
      row.month = m;
      if (row.repeat_kind === 'once') row.base_year = y;
      return;
    }
    row[column] = value;
    /* Этап или трату, созданные шаблоном, правка закрепляет: с этого момента
       повторяющееся накопление и праздники это вхождение не перезаписывают. */
    if (domain === 'savings' && (table === 'goal_milestones' || table === 'goal_transactions')
      && row.source && row.source !== 'manual') {
      row.user_edited = true;
    }
    if (el.dataset.removeWhen !== undefined && String(value) === el.dataset.removeWhen) {
      rows.splice(rows.indexOf(row), 1);
    }
  });
  return true;
}

export function addRow(store, domain, table, row) {
  store.update(domain, d => {
    const rows = d[table] ?? (d[table] = []);
    rows.push(row);
  });
  return row;
}

/* Обе стороны перевода: пара движений с одинаковым occurrence_key */
function transferPair(state, tx) {
  const key = tx?.occurrence_key;
  if (!key || !String(key).startsWith('transfer:')) return [];
  return (state.savings?.goal_transactions ?? []).filter(t => t.occurrence_key === key);
}

/* Поправили одну сторону перевода — вторая должна совпасть */
export function syncTransfer(store, tx) {
  const pair = transferPair(store.state, tx);
  if (pair.length < 2) return;
  store.update('savings', d => {
    for (const other of d.goal_transactions.filter(t => t.occurrence_key === tx.occurrence_key && t.id !== tx.id)) {
      other.date = tx.date;
      other.amount = tx.amount;
      other.title = tx.title;
    }
  });
}

export function deleteRow(store, domain, table, key) {
  const state = store.state;
  const row = findRow(state, domain, table, key);

  // перевод удаляется парой
  if (domain === 'savings' && table === 'goal_transactions') {
    const pair = transferPair(state, row);
    if (pair.length > 1) {
      const ids = new Set(pair.map(t => t.id));
      store.update('savings', d => { d.goal_transactions = d.goal_transactions.filter(t => !ids.has(t.id)); });
      return;
    }
  }

  // год плана уносит и свои выплаты со всеми их ручными суммами
  if (domain === 'income' && table === 'plan_years') {
    const year = Number(row?.year ?? key.year);
    for (const p of (state.income?.periods ?? []).filter(x => Number(x.year) === year)) {
      deleteRow(store, 'income', 'periods', { id: p.id });
    }
  }
  for (const [depDomain, depTable, depColumn] of DEPENDENTS[`${domain}|${table}`] ?? []) {
    const value = row?.[Object.keys(key)[0]] ?? Object.values(key)[0];
    store.update(depDomain, d => {
      if (!d[depTable]) return;
      d[depTable] = d[depTable].filter(r => String(r[depColumn]) !== String(value));
    });
  }
  store.update(domain, d => {
    if (!d[table]) return;
    d[table] = d[table].filter(r => !matches(r, key));
  });
}

/* Параметры покупки поменялись — график будущих платежей пересобирается */
const SCHEDULE_FIELDS = new Set(['total', 'parts', 'every_n', 'period_unit', 'first_date']);

/* Обработчики на контейнере: одна установка на всё приложение */
export function attachEditing(container, store, getCtx, onError) {
  const run = fn => { try { fn(); } catch (e) { onError(e); } };

  container.addEventListener('change', ev => {
    const el = ev.target.closest('[data-edit]');
    if (!el) return;
    run(() => {
      const ctx = getCtx();
      if (!applyEdit(store, el, ctx.fmt)) { el.classList.add('bad-value'); return; }
      el.classList.remove('bad-value');
      const [domain, table, column] = el.dataset.edit.split('|');
      const key = JSON.parse(el.dataset.key || '{}');

      if (domain === 'savings' && table === 'goal_transactions') {
        const tx = findRow(store.state, domain, table, key);
        if (tx) syncTransfer(store, tx);
      }
      // своя сумма отпускных: как только её ввели, отпуск перестаёт считаться по формуле
      if (domain === 'income' && table === 'vacations' && column === 'pay_amount') {
        store.update('income', d => {
          const v = (d.vacations ?? []).find(x => x.id === key.id);
          if (v) v.pay_manual = true;
        });
      }
      if (domain === 'debts' && table === 'installments' && SCHEDULE_FIELDS.has(column)) {
        const inst = findRow(store.state, domain, table, key);
        if (inst) {
          const units = ctx.cfg.list('period_units');
          store.update('debts', d => {
            const others = (d.installment_payments ?? []).filter(p => p.installment_id !== inst.id);
            d.installment_payments = [...others, ...rebuildFuture(inst, d.installment_payments ?? [], ctx.today, units)];
          });
        }
      }
    });
  });

  container.addEventListener('click', ev => {
    const add = ev.target.closest('[data-add]');
    if (add) {
      const [domain, table] = add.dataset.add.split('|');
      const row = JSON.parse(add.dataset.row || '{}');
      run(() => addRow(store, domain, table, row));
      return;
    }
    const del = ev.target.closest('[data-del]');
    if (del) {
      const [domain, table] = del.dataset.del.split('|');
      const text = del.dataset.confirm;
      if (text && !window.confirm(text)) return;
      run(() => deleteRow(store, domain, table, JSON.parse(del.dataset.key || '{}')));
    }
  });

  container.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.matches('input:not([type=checkbox]):not([type=date])')) ev.target.blur();
  });
}
