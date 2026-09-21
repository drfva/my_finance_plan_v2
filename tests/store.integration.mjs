/* Интеграционная проверка store.js и движка против настоящих 001/002 в локальном Postgres.
   Нужны: локальный Postgres с базой it (000_supabase_stub.sql + ../v2/sql/001_schema.sql + 002_api.sql) и npm-пакет pg.
   В npm test не входит. Запуск: node tests/store.integration.mjs */
// Интеграционная проверка: настоящий store.js против настоящих 001/002 в локальном Postgres
import pg from 'pg';
import assert from 'node:assert/strict';
import { createStore } from '../src/core/store.js';

const pool = new pg.Pool({ host: '/tmp', user: 'postgres', database: 'it' });

function pgClient(uid) {
  return {
    async rpc(name, args = {}) {
      const keys = Object.keys(args);
      const params = keys.map(k => { const v = args[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
      const cast = k => (k === 'p_patch' ? '::jsonb' : k === 'p_account' ? '::uuid' : k === 'p_version' ? '::bigint' : '::text');
      const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}${cast(k)}`).join(', ')}) as r`;
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
        const res = await c.query(sql, params);
        await c.query('commit');
        return { data: res.rows[0].r, error: null, status: 200 };
      } catch (e) {
        await c.query('rollback');
        return { data: null, error: { code: e.code, message: e.message }, status: e.code === 'PT409' ? 409 : 400 };
      } finally { c.release(); }
    },
  };
}

const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002';
await pool.query(`insert into auth.users values ($1,'a@x.ru'),($2,'b@x.ru') on conflict do nothing`, [A, B]);
const ok = m => console.log('PASS', m);

// 1. первый вход
const s1 = createStore({ client: pgClient(A), debounceMs: 10 });
await s1.load({ title: 'План А' });
assert.equal(s1.state.account.title, 'План А'); ok('первый вход создаёт план');
assert.equal(s1.config().stages().length, 6); ok('этапы распределения из справочника');

// 2. настройки
s1.setSetting('rounding', 10); s1.setSetting('locale', 'en-US'); s1.setAccountTitle('Наш план');
s1.update('settings', st => { st.allocation_rules.find(r => r.stage_code === 'gifts').enabled = false; });
await s1.flush();
let fresh = createStore({ client: pgClient(A) }); await fresh.load();
assert.equal(fresh.config().get('rounding'), 10);
assert.equal(fresh.config().get('locale'), 'en-US');
assert.equal(fresh.state.account.title, 'Наш план');
assert.equal(fresh.config().stages().find(s => s.code === 'gifts').enabled, false);
ok('настройки, название и этап сохранились и читаются заново');
s1.setSetting('rounding', null); await s1.flush();
fresh = createStore({ client: pgClient(A) }); await fresh.load();
assert.equal(fresh.config().source('rounding'), 'default'); ok('сброс настройки к умолчанию');

// 3. данные домена
s1.update('income', inc => {
  inc.plan_years.push({ year: 2027 });
  inc.periods.push({ id: 'p1', year: 2027, pay_date: '2027-01-05', window_start: '2026-12-16', window_end: '2026-12-31', income_net: 100000 });
});
await s1.flush();
assert.equal(s1.state.versions.income, 1);
fresh = createStore({ client: pgClient(A) }); await fresh.load();
assert.equal(fresh.state.income.periods[0].income_net, 100000); ok('выплата записана, версия 1');

assert.equal(s1.state.income.periods[0].note, ''); assert.equal(s1.state.income.periods[0].locked, false);
ok('после сохранения в состоянии строки со значениями по умолчанию');
s1.update('income', inc => { inc.periods = fresh.state.income.periods; });
await s1.flush();
assert.equal(s1.state.versions.income, 1); ok('те же строки повторно: версия не растёт');

// 4. две вкладки
const tab1 = createStore({ client: pgClient(A), debounceMs: 10 }); await tab1.load();
const tab2 = createStore({ client: pgClient(A), debounceMs: 10 }); await tab2.load();
let conflict = false; tab2.subscribe(e => { if (e.type === 'conflict') conflict = true; });
tab1.update('income', inc => { inc.periods[0].note = 'из первой вкладки'; }); await tab1.flush();
tab2.update('income', inc => { inc.periods[0].note = 'из второй вкладки'; }); await tab2.flush();
assert.equal(conflict, true);
assert.equal(tab2.state.income.periods[0].note, 'из первой вкладки');
assert.equal(tab2.state.versions.income, tab1.state.versions.income);
ok('две вкладки: вторая получает конфликт и свежие данные');
tab2.update('income', inc => { inc.periods[0].note = 'вторая после обновления'; }); await tab2.flush();
assert.equal(tab2.status(), 'saved'); ok('после конфликта вторая вкладка снова сохраняет');

// 5. зритель
await pool.query(`insert into account_members (account_id, user_id, role) values ($1,$2,'viewer')`, [s1.state.account.id, B]);
const v = createStore({ client: pgClient(B), debounceMs: 10 }); await v.load();
assert.equal(v.state.account.role, 'viewer');
assert.equal(v.state.income.periods.length, 1);
v.setSetting('locale', 'ru-RU'); await v.flush();
assert.equal(v.status(), 'saved'); ok('зритель видит план и меняет свой язык');
assert.throws(() => v.update('income', () => {})); ok('зритель не может править план');

// 6. ошибка базы доходит до статуса
tab2.update('income', inc => { inc.periods.push({ id: 'bad', year: 2027, pay_date: '2027-13-40', window_start: '2027-01-01', window_end: '2027-01-02' }); });
await tab2.flush();
assert.equal(tab2.status(), 'error'); ok('ошибка базы: статус error, правка не потеряна');
tab2.update('income', inc => { inc.periods = inc.periods.filter(p => p.id !== 'bad'); });
await tab2.flush();
assert.equal(tab2.status(), 'saved'); ok('исправили — сохраняется');



// 7. полный пример плана целиком уходит в базу и читается обратно
const { fillSample } = await import('../src/ui/settings.js');
const { generateYear } = await import('../src/engine/income.js');
const { simulate } = await import('../src/engine/allocation.js');
const { syncGenerated } = await import('../src/engine/savings.js');
const { createConfig } = await import('../src/core/config.js');

const C = 'cccccccc-0000-0000-0000-000000000003';
await pool.query(`insert into auth.users values ($1,'c@x.ru') on conflict do nothing`, [C]);
const full = createStore({ client: pgClient(C), debounceMs: 5 });
await full.load({ title: 'Полный план' });
const year = 2027;
fillSample({ store: full }, year);
await full.flush();
assert.equal(full.status(), 'saved'); ok('пример плана сохранён целиком');

let cfg = full.config();
const generated = generateYear(full.state, cfg, year, { round: cfg.formatter().round });
full.update('income', d => { d.periods = [...d.periods, ...generated]; });
await full.flush();
assert.equal(full.state.income.periods.length, 24); ok('24 выплаты по графику сохранены');

const gen = syncGenerated({
  savings: full.state.savings, gifts: full.state.gifts,
  until: `${year}-12-31`, years: [year], today: `${year}-01-01`, units: cfg.list('period_units'),
  goalKinds: Object.fromEntries(cfg.list('goal_kinds').map(k => [k.code, k.stage_code])),
});
full.update('savings', d => { d.goal_milestones = gen.goal_milestones; d.goal_transactions = gen.goal_transactions; });
full.update('settings', d => {
  const rule = d.allocation_rules.find(r => r.stage_code === 'credits');
  rule.params = { early_repayment: false };
});
await full.flush();
assert.equal(full.status(), 'saved'); ok('этапы из праздников и параметры этапа сохранены');

const reread = createStore({ client: pgClient(C) });
await reread.load();
cfg = reread.config();
const simA = simulate(full.state, full.config(), { round: cfg.formatter().round });
const simB = simulate(reread.state, cfg, { round: cfg.formatter().round });
assert.equal(simB.rows.length, simA.rows.length);
const totalA = simA.rows.reduce((s, r) => s + r.unallocated, 0);
const totalB = simB.rows.reduce((s, r) => s + r.unallocated, 0);
assert.ok(Math.abs(totalA - totalB) < 0.01);
assert.equal(cfg.stages().find(s => s.code === 'credits').params.early_repayment, false);
ok('после перезагрузки из базы расчёт совпадает');

await pool.end();
