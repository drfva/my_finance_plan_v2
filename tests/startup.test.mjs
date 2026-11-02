import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPersonalPlan } from '../src/core/startup.js';

function storeFor(account, accounts) {
  return {
    state: { account, accounts }, switched: [],
    async switchAccount(id) { this.switched.push(id); this.state.account = accounts.find(a => a.id === id) ?? { id, plan_kind: 'personal' }; },
  };
}
const family = { id: 'family', plan_kind: 'family', role: 'owner' };
const personal = { id: 'mine', plan_kind: 'personal', role: 'owner' };

test('вход: из семейного плана переходим в собственный личный, а не в чужой общий', async () => {
  const store = storeFor(family, [family, { id: 'shared', plan_kind: 'personal', role: 'editor' }, personal]);
  await openPersonalPlan(store, { rpc() { throw new Error('Не требуется создание'); } }, 'family');
  assert.deepEqual(store.switched, ['mine']);
});

test('вход: сохранённая ссылка на чужой или другой собственный план не меняет стартовый план', async () => {
  const second = { id: 'second', plan_kind: 'personal', role: 'owner' };
  const shared = { id: 'shared', plan_kind: 'personal', role: 'editor' };
  for (const previous of ['shared','second','family','unavailable']) {
    const store = storeFor(personal, [family, shared, personal, second]);
    await openPersonalPlan(store, {}, previous);
    assert.deepEqual(store.switched, ['mine']);
  }
});

test('вход: текущий собственный личный план сохраняется; старый план без plan_kind поддерживается', async () => {
  for (const current of [personal, { id: 'old', role: 'owner' }]) {
    const store = storeFor(current, [family, { id: 'other', plan_kind: 'personal', role: 'owner' }, current]);
    await openPersonalPlan(store, {});
    assert.deepEqual(store.switched, [current.id]);
  }
});

test('вход: доступ к чужому плану до первого входа не заменяет собственный план', async () => {
  const shared = { id: 'shared', plan_kind: 'personal', role: 'editor' };
  for (const current of [family, shared]) {
    const store = storeFor(current, [family, shared]);
    await openPersonalPlan(store, { async rpc() { return { data: 'new-personal', error: null }; } },'shared');
    assert.deepEqual(store.switched, ['new-personal']);
  }
});

test('вход: если осталась только семья, создаётся личный план, ошибка создания не игнорируется', async () => {
  const store = storeFor(family, [family]);
  const calls = [];
  await openPersonalPlan(store, { async rpc(name, args) { calls.push([name, args]); return { data: 'new-personal', error: null }; } });
  assert.deepEqual(calls, [['create_account', { p_title: 'Мой план' }]]);
  assert.deepEqual(store.switched, ['new-personal']);
  const failed = storeFor(family, [family]);
  await assert.rejects(openPersonalPlan(failed, { async rpc() { return { error: new Error('connection') }; } }), /connection/);
  assert.deepEqual(failed.switched, []);
});
