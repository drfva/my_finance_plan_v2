import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanCache } from '../src/ui/plan-cache.js';
import { createStore, DOMAINS } from '../src/core/store.js';
import { computeIncome } from '../src/engine/income.js';
import { simulate } from '../src/engine/allocation.js';
import fs from 'node:fs';

test('расчёт переиспользуется до изменения данных, настроек, плана или текущего дня', () => {
  let today = '2026-11-04', incomes = 0, simulations = 0;
  const formatter = { todayISO: () => today, round: Math.round };
  const config = () => ({ formatter: () => formatter });
  const cache = createPlanCache({
    incomeOf() { incomes++; return { total: incomes }; },
    simulatePlan(state, cfg, options) { simulations++; return { income: options.income }; },
  });
  const state = {}, cfg = config();
  const first = cache(state, cfg);
  for (let i = 0; i < 30; i++) assert.equal(cache(state, cfg), first);
  assert.equal(incomes, 1); assert.equal(simulations, 1);
  assert.notEqual(cache(state, config()), first);
  cache({}, cfg);
  today = '2026-11-05'; cache(state, cfg);
  assert.equal(incomes, 4); assert.equal(simulations, 4);
});

test('правки всех доменов и загрузка плана сбрасывают кэш; результат совпадает с полным расчётом', async () => {
  const source = JSON.parse(fs.readFileSync(new URL('../tools/preview/state.json', import.meta.url), 'utf8'));
  source.account.can_edit = true;
  const store = createStore({ client: { async rpc() { return { data: structuredClone(source), error: null }; } },
    setTimer: () => 1, clearTimer() {} });
  await store.load();
  let simulations = 0;
  const cache = createPlanCache({ simulatePlan(...args) { simulations++; return simulate(...args); } });
  const check = () => {
    const result = cache(store.state, store.config());
    const income = computeIncome(store.state, store.config(), { round: result.fmt.round });
    const fresh = simulate(store.state, store.config(), { income, round: result.fmt.round, today: result.today });
    assert.deepEqual(result.sim.rows.map(r => [r.income.total, r.categoriesTotal, r.installmentsTotal, r.free, r.allocations]),
      fresh.rows.map(r => [r.income.total, r.categoriesTotal, r.installmentsTotal, r.free, r.allocations]));
    return result;
  };
  let previous = check();
  for (const domain of DOMAINS) {
    store.update(domain, d => { d.cache_test = 1; });
    const next = check();
    assert.notEqual(next, previous, domain);
    previous = next;
  }
  await store.load();
  assert.notEqual(check(), previous);
  assert.equal(simulations, DOMAINS.length + 2);
});
