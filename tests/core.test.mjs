/* Тесты ядра: node --test tests/
   Браузер и база не нужны: клиент Supabase подменяется заглушкой. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFormat, parseISODate } from '../src/core/format.js';
import { createConfig } from '../src/core/config.js';
import { createStore, DOMAINS } from '../src/core/store.js';

const NB = ' ';
const norm = s => s.replace(/[  ]/g, ' ');

/* ------------------------------------------------------------------ format */

test('format: деньги, округление, валюты', () => {
  const currencies = [{ code: 'RUB', symbol: '₽' }, { code: 'USD', symbol: '$' }];
  const f = createFormat({ locale: 'ru-RU', currency: 'RUB', rounding: 1, currencies });
  assert.equal(norm(f.money(1234567.5)), '1 234 568 ₽');
  assert.equal(norm(f.money(-2500)), '−2 500 ₽');
  assert.equal(norm(f.money(100, 'USD')), '100 $');
  assert.equal(norm(f.money(5, 'RUB', { sign: true })), '+5 ₽');
  assert.equal(f.money(NaN), '—');

  const tens = createFormat({ rounding: 10, currencies });
  assert.equal(tens.round(1234), 1230);
  assert.equal(tens.round(1235), 1240);

  const cents = createFormat({ rounding: 0.01, currencies });
  assert.equal(cents.round(0.1 + 0.2), 0.3);
  assert.equal(norm(cents.money(10.5)), '10,5 ₽');
});

test('format: даты без сдвига часового пояса', () => {
  const f = createFormat({ locale: 'ru-RU' });
  assert.equal(f.date('2027-01-05'), '05.01.2027');
  assert.equal(f.date('2027-01-05', 'dayMonth'), '05.01');
  assert.equal(f.month('2027-03'), 'март 2027');
  assert.equal(f.monthName(12), 'декабрь');
  assert.equal(parseISODate('2027-02-30'), null);
  assert.equal(f.toISODate(parseISODate('2027-12-31')), '2027-12-31');
});

test('format: склонения по локали', () => {
  const ru = createFormat({ locale: 'ru-RU' });
  const forms = { one: 'выплата', few: 'выплаты', many: 'выплат', other: 'выплаты' };
  assert.deepEqual([1, 2, 5, 11, 21, 22].map(n => ru.plural(n, forms)),
    ['выплата', 'выплаты', 'выплат', 'выплат', 'выплата', 'выплаты']);
  assert.equal(norm(ru.count(5, forms)), '5 выплат');

  const en = createFormat({ locale: 'en-US' });
  assert.equal(en.plural(1, { one: 'payout', other: 'payouts' }), 'payout');
  assert.equal(en.plural(3, { one: 'payout', other: 'payouts' }), 'payouts');
});

test('format: разбор введённых чисел', () => {
  const f = createFormat({ rounding: 1 });
  assert.equal(f.parseNumber('1 234,5'), 1234.5);
  assert.equal(f.parseNumber(`1${NB}234`), 1234);
  assert.equal(f.parseNumber('1,234.5'), 1234.5);
  assert.equal(f.parseNumber('1.234,5'), 1234.5);
  assert.equal(f.parseNumber('−500'), -500);
  assert.equal(f.parseNumber('abc'), null);
  assert.equal(f.parseNumber(''), null);
  assert.equal(f.parseMoney('99,6'), 100);
});

/* ------------------------------------------------------------------ config */

const REF = {
  setting_defaults: [
    { key: 'base_currency', value: 'RUB', scope: 'account', title: 'Базовая валюта', description: '' },
    { key: 'extra_currencies', value: ['USD', 'EUR'], scope: 'account', title: '', description: '' },
    { key: 'rounding', value: 1, scope: 'account', title: '', description: '' },
    { key: 'fact_tolerance_pct', value: 5, scope: 'account', title: '', description: '' },
    { key: 'calendar_code', value: 'ru', scope: 'account', title: '', description: '' },
    { key: 'locale', value: 'ru-RU', scope: 'user', title: '', description: '' },
    { key: 'start_tab', value: 'dashboard', scope: 'user', title: '', description: '' },
  ],
  allocation_stages: [
    { code: 'categories', title: 'Категории', default_priority: 1, description: '' },
    { code: 'gifts', title: 'Подарки', default_priority: 2, description: '' },
    { code: 'reserves', title: 'Подушки', default_priority: 6, description: '' },
  ],
  currencies: [
    { code: 'RUB', title: 'Рубль', symbol: '₽' },
    { code: 'USD', title: 'Доллар', symbol: '$' },
    { code: 'EUR', title: 'Евро', symbol: '€' },
  ],
  calendars: [{ code: 'ru', title: 'Россия' }],
};

function makeState(over = {}) {
  return {
    user: { id: 'u1', settings: {} },
    accounts: [{ id: 'a1', title: 'План', role: 'owner' }],
    account: { id: 'a1', title: 'План', base_currency: 'RUB', calendar_code: 'ru', role: 'owner', can_edit: true },
    ref: REF,
    versions: Object.fromEntries(DOMAINS.map(d => [d, 0])),
    settings: {
      account_settings: { rounding: 10 },
      allocation_rules: [
        { stage_code: 'categories', priority: 1, enabled: true, params: {} },
        { stage_code: 'gifts', priority: 5, enabled: false, params: {} },
      ],
      fx_rates: [],
    },
    income: { periods: [], sick_leaves: [] },
    expenses: { expense_categories: [] },
    debts: {}, savings: {}, gifts: {}, facts: { expense_facts: [] },
    ...over,
  };
}

test('config: своё значение, умолчание, неизвестный ключ', () => {
  const cfg = createConfig(makeState());
  assert.equal(cfg.get('rounding'), 10);
  assert.equal(cfg.source('rounding'), 'own');
  assert.equal(cfg.get('fact_tolerance_pct'), 5);
  assert.equal(cfg.source('fact_tolerance_pct'), 'default');
  assert.equal(cfg.get('locale'), 'ru-RU');
  assert.throws(() => cfg.get('nope'), /Неизвестная настройка/);
  assert.equal(cfg.all('user').length, 2);
  assert.equal(cfg.all().find(s => s.key === 'rounding').isDefault, false);
});

test('config: этапы по приоритету плана, новый этап из справочника включён', () => {
  const stages = createConfig(makeState()).stages();
  assert.deepEqual(stages.map(s => [s.code, s.priority, s.enabled, s.configured]), [
    ['categories', 1, true, true],
    ['gifts', 5, false, true],
    ['reserves', 6, true, false],
  ]);
});

test('config: справочники и форматтер из настроек', () => {
  const cfg = createConfig(makeState());
  assert.equal(cfg.byCode('currencies', 'USD').symbol, '$');
  assert.throws(() => cfg.list('unknown'), /Неизвестный справочник/);
  const f = cfg.formatter();
  assert.equal(f.rounding, 10);
  assert.equal(norm(f.money(1234)), '1 230 ₽');
  assert.equal(cfg.canEdit, true);
});

/* ------------------------------------------------------------------ store */

/* Заглушка клиента: запоминает вызовы, отвечает по сценарию */
function fakeClient(state, { onSave } = {}) {
  const calls = [];
  const server = JSON.parse(JSON.stringify(state));
  return {
    calls,
    server,
    async rpc(name, args) {
      calls.push({ name, args: JSON.parse(JSON.stringify(args ?? {})) });
      if (name === 'bootstrap_user' || name === 'state_get') return { data: JSON.parse(JSON.stringify(server)), error: null };
      if (name === 'state_save') {
        if (onSave) {
          const r = await onSave(args, server);
          if (r) return r;
        }
        const v = (server.versions[args.p_domain] ?? 0) + 1;
        server.versions[args.p_domain] = v;
        for (const [t, rows] of Object.entries(args.p_patch)) {
          if (Array.isArray(rows)) server[args.p_domain][t] = rows;
        }
        return { data: { domain: args.p_domain, version: v, changed: 1 }, error: null };
      }
      throw new Error('unexpected rpc ' + name);
    },
  };
}

/* Таймеры вручную: сохранение уходит, когда тест вызывает tick() */
function manualTimers() {
  let queue = [];
  return {
    setTimer(fn) { const t = { fn }; queue.push(t); return t; },
    clearTimer(t) { queue = queue.filter(x => x !== t); },
    async tick() { const q = queue; queue = []; q.forEach(t => t.fn()); await new Promise(r => setTimeout(r, 0)); },
    get size() { return queue.length; },
  };
}

test('store: загрузка через bootstrap_user, статус saved', async () => {
  const client = fakeClient(makeState());
  const store = createStore({ client });
  await store.load();
  assert.equal(client.calls[0].name, 'bootstrap_user');
  assert.equal(store.state.account.id, 'a1');
  assert.equal(store.status(), 'saved');
  assert.equal(store.config().get('rounding'), 10);
});

test('store: в патч уходят только изменённые таблицы, правки подряд — одним запросом', async () => {
  const client = fakeClient(makeState());
  const timers = manualTimers();
  const store = createStore({ client, ...timers });
  await store.load();

  store.update('income', inc => { inc.periods.push({ id: 'p1', pay_date: '2027-01-05' }); });
  store.update('income', inc => { inc.periods[0].income_net = 100; });
  assert.equal(store.status(), 'pending');
  assert.equal(timers.size, 1);
  await timers.tick();

  const saves = client.calls.filter(c => c.name === 'state_save');
  assert.equal(saves.length, 1);
  assert.deepEqual(Object.keys(saves[0].args.p_patch), ['periods']);
  assert.equal(saves[0].args.p_patch.periods[0].income_net, 100);
  assert.equal(saves[0].args.p_version, 0);
  assert.equal(saves[0].args.p_account, 'a1');
  assert.equal(store.state.versions.income, 1);
  assert.equal(store.status(), 'saved');

  // следующая правка идёт уже с новой версией
  store.update('income', inc => { inc.sick_leaves.push({ id: 's1' }); });
  await timers.tick();
  const second = client.calls.filter(c => c.name === 'state_save')[1];
  assert.deepEqual(Object.keys(second.args.p_patch), ['sick_leaves']);
  assert.equal(second.args.p_version, 1);
});

test('store: правка без изменения данных запрос не шлёт', async () => {
  const client = fakeClient(makeState());
  const timers = manualTimers();
  const store = createStore({ client, ...timers });
  await store.load();
  store.update('income', inc => { inc.periods = [...inc.periods]; });
  await timers.tick();
  assert.equal(client.calls.filter(c => c.name === 'state_save').length, 0);
});

test('store: настройки — только изменённые ключи, null для сброса, название плана', async () => {
  const client = fakeClient(makeState());
  const timers = manualTimers();
  const store = createStore({ client, ...timers });
  await store.load();

  store.setSetting('rounding', null);          // было своё 10 → умолчание
  store.setSetting('fact_tolerance_pct', 3);
  store.setSetting('locale', 'en-US');         // личная
  store.setAccountTitle('Наш план');
  assert.equal(store.config().get('rounding'), 1);
  assert.equal(store.config().get('locale'), 'en-US');
  await timers.tick();

  const save = client.calls.find(c => c.name === 'state_save');
  assert.equal(save.args.p_domain, 'settings');
  assert.deepEqual(save.args.p_patch, {
    account_settings: { fact_tolerance_pct: 3, rounding: null },
    user_settings: { locale: 'en-US' },
    account: { title: 'Наш план' },
  });
});

test('store: базовая валюта в настройках обновляет и account', async () => {
  const store = createStore({ client: fakeClient(makeState()), ...manualTimers() });
  await store.load();
  store.setSetting('base_currency', 'USD');
  assert.equal(store.state.account.base_currency, 'USD');
  store.setSetting('base_currency', null);
  assert.equal(store.state.account.base_currency, 'RUB');
});

test('store: правка во время сохранения уходит следующим запросом', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let first = true;
  const client = fakeClient(makeState(), {
    onSave: async () => { if (first) { first = false; await gate; } },
  });
  const timers = manualTimers();
  const store = createStore({ client, ...timers });
  await store.load();

  store.update('income', inc => { inc.periods.push({ id: 'p1' }); });
  const firstSave = store.save('income');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(store.status(), 'saving');

  store.update('income', inc => { inc.periods.push({ id: 'p2' }); });
  const secondSave = store.save('income');     // встаёт в очередь, не параллельно
  release();
  await firstSave; await secondSave;

  const saves = client.calls.filter(c => c.name === 'state_save');
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[1].args.p_patch.periods.map(p => p.id), ['p1', 'p2']);
  assert.equal(saves[1].args.p_version, 1);
  assert.equal(store.status(), 'saved');
});

test('store: конфликт 409 — домен перечитан, событие conflict', async () => {
  const client = fakeClient(makeState(), {
    onSave: (args, server) => {
      server.versions.income = 7;
      server.income.periods = [{ id: 'from-other-tab' }];
      return { data: null, error: { code: 'PT409', message: 'изменено' }, status: 409 };
    },
  });
  const timers = manualTimers();
  const store = createStore({ client, ...timers });
  await store.load();
  const events = [];
  store.subscribe(e => events.push(e.type));

  store.update('income', inc => { inc.periods.push({ id: 'mine' }); });
  await timers.tick();
  await new Promise(r => setTimeout(r, 0));

  assert.ok(events.includes('conflict'));
  assert.deepEqual(store.state.income.periods.map(p => p.id), ['from-other-tab']);
  assert.equal(store.state.versions.income, 7);
  assert.equal(store.status(), 'saved');
  assert.equal(store.hasPending(), false);
});

test('store: ошибка сохранения держит правку до следующей попытки', async () => {
  let fail = true;
  const client = fakeClient(makeState(), {
    onSave: () => (fail ? { data: null, error: { code: '08006', message: 'нет сети' }, status: 0 } : null),
  });
  const timers = manualTimers();
  const store = createStore({ client, ...timers });
  await store.load();

  store.update('facts', f => { f.expense_facts.push({ ym: '2027-01', category_id: 'c', item_key: '', amount: 5 }); });
  await timers.tick();
  assert.equal(store.status(), 'error');
  assert.equal(store.hasPending(), true);

  fail = false;
  await store.flush();
  assert.equal(store.status(), 'saved');
  assert.equal(client.server.facts.expense_facts.length, 1);
});

test('store: зритель не может править план, но может свои настройки', async () => {
  const state = makeState();
  state.account.role = 'viewer';
  state.account.can_edit = false;
  const store = createStore({ client: fakeClient(state), ...manualTimers() });
  await store.load();
  assert.throws(() => store.update('income', () => {}), /только на просмотр/);
  assert.throws(() => store.setSetting('rounding', 5), /только на просмотр/);
  assert.doesNotThrow(() => store.setSetting('locale', 'en-US'));
});

test('store: пустые справочники — понятная ошибка, а не падение интерфейса', async () => {
  const state = makeState();
  state.ref = { ...REF, setting_defaults: [], currencies: [] };
  const store = createStore({ client: fakeClient(state) });
  await assert.rejects(store.load(), /ref_setting_defaults, ref_currencies.*002_api\.sql/);
});
