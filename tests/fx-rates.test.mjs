import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyRates, createFxUpdater } from '../src/core/fx-rates.js';
import { createStore } from '../src/core/store.js';
import { createFx } from '../src/engine/fx.js';

const feed = { Date: '2026-11-05T11:30:00+03:00', PreviousDate: '2026-11-04T11:30:00+03:00', Valute: {
  USD: { CharCode: 'USD', Nominal: 1, Value: 110, Previous: 100 },
  EUR: { CharCode: 'EUR', Nominal: 1, Value: 220, Previous: 200 },
  JPY: { CharCode: 'JPY', Nominal: 100, Value: 70, Previous: 60 },
} };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('курсы: действующая дата, номинал и кросс-курс; будущая публикация не подменяет сегодняшний курс', () => {
  const rub = dailyRates(feed, '2026-11-04', 'RUB', ['USD', 'EUR', 'JPY']);
  assert.equal(rub.date, '2026-11-04');
  assert.deepEqual(rub.rates.map(r => r.rate), [100, 200, 0.6]);
  const eur = dailyRates(feed, '2026-11-04', 'EUR', ['USD', 'RUB']);
  assert.deepEqual(eur.rates.map(r => r.rate), [0.5, 0.005]);
  assert.equal(dailyRates(feed, '2026-11-05', 'RUB', ['USD']).rates[0].rate, 110);
  assert.throws(() => dailyRates(feed, '2026-11-03', 'RUB', ['USD']));
  const fx = createFx([{ base_code: 'RUB', quote_code: 'USD', rate_date: '2026-11-05', rate: 110 }], 'RUB', { asOf: '2026-11-04' });
  assert.equal(fx.toBase(100, 'USD', '2027-01-01'), null);
});

async function setup(canEdit = true) {
  const state = { account: { id: 'a', can_edit: canEdit, plan_kind: 'personal' }, settings: { fx_rates: [], account_settings: {} },
    ref: { currencies: [{ code: 'RUB' }, { code: 'USD' }], allocation_stages: [{ code: 'buckets' }],
      setting_defaults: [{ key: 'base_currency', value: 'RUB', scope: 'account' }] },
    savings: { goals: [{ id: 'usd', currency_code: 'USD' }] } };
  const store = createStore({ client: { rpc: async () => ({ data: structuredClone(state), error: null }) }, setTimer: () => 1, clearTimer() {} });
  await store.load(); return store;
}

test('автозагрузка: один запрос в день, сохранение редактором и новый курс при смене дня', async () => {
  const store = await setup();
  let day = '2026-11-04', requests = 0;
  const updater = createFxUpdater(store, { day: () => day, fetcher: async (url, options) => {
    requests++; assert.equal(options.credentials, 'omit'); assert.equal(new URL(url).search, '');
    return { ok: true, json: async () => feed };
  } });
  updater.ensure(); await tick();
  assert.equal(store.state.settings.fx_rates[0].rate, 100);
  for (let i = 0; i < 10; i++) updater.ensure();
  await tick(); assert.equal(requests, 1);
  await store.load(); updater.ensure(); await tick();
  assert.equal(requests, 1); assert.equal(store.state.current_fx.rates[0].rate, 100);
  day = '2026-11-05'; updater.ensure(); await tick();
  assert.equal(requests, 2); assert.equal(store.state.current_fx.rates[0].rate, 110);
  assert.equal(store.state.settings.fx_rates.length, 2);
});

test('читатель: актуальный курс доступен без записи в БД; ошибка сети сохраняет прошлый курс и позволяет повторить', async () => {
  const store = await setup(false);
  let fail = false, time = 0;
  const updater = createFxUpdater(store, { day: () => '2026-11-04', now: () => time,
    fetcher: async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => feed }; } });
  updater.ensure(); await tick();
  assert.equal(store.state.current_fx.rates[0].rate, 100);
  assert.equal(store.state.settings.fx_rates.length, 0);
  assert.equal(store.hasPending(), false);
  fail = true;
  store.state.savings.goals.push({ id: 'eur', currency_code: 'EUR' });
  // Ответ этого дня переиспользуется и для другой валюты.
  updater.ensure(); await tick();
  assert.equal(store.state.current_fx.rates.length, 2);
  const broken = createFxUpdater(store, { day: () => '2026-11-04', now: () => time,
    fetcher: async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => feed }; } });
  broken.ensure(); await tick();
  assert.equal(store.state.current_fx.error, true); assert.equal(store.state.current_fx.rates.find(r => r.quote_code === 'USD').rate, 100);
  fail = false; time = 60001;
  broken.ensure(); await tick(); assert.equal(store.state.current_fx.error, false);
});

test('смена плана во время загрузки: запоздалый ответ не записывает валюты предыдущего плана', async () => {
  const store = await setup();
  let resolve;
  const updater = createFxUpdater(store, { day: () => '2026-11-04', fetcher: () => new Promise(done => { resolve = done; }) });
  updater.ensure(); await tick();
  store.state.account.id = 'b';
  store.state.savings.goals = [{ id:'eur', currency_code:'EUR' }];
  updater.ensure();
  resolve({ ok:true, json:async () => feed }); await tick();
  assert.deepEqual(store.state.settings.fx_rates.map(r => r.quote_code), ['EUR']);
});
