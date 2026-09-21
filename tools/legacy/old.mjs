// Загружает логику старой версии (index.html) в песочницу и отдаёт её функции
import fs from 'node:fs';
import vm from 'node:vm';
export function loadOld(today = '2026-09-19') {
  const html = fs.readFileSync(new URL('./old.html', import.meta.url), 'utf8');
  const start = html.indexOf('<script id="app-logic">') + '<script id="app-logic">'.length;
  const end = html.indexOf('</script>', start);
  let code = html.slice(start, end);
  code = code.replace(/if\(document\.readyState==='loading'\)[^\n]*\n/, 'globalThis.__old = { simulate, computeSalaryNetPlan, generateYearPeriods, DEFAULT_STATE, vacationPayForPeriod, categoriesTotalForPeriod, goalMilestones };\n');
  const fakeEl = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : fakeEl), apply: () => fakeEl, set: () => true });
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(today + 'T12:00:00'); } static now() { return new RealDate(today + 'T12:00:00').getTime(); } }
  const ctx = { document: fakeEl, window: {}, location: { hash: '', pathname: '/', origin: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    supabaseClient: fakeEl, APP_CONFIG: { env: 'dev' }, console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, confirm: () => true, alert() {},
    Date: FixedDate, Math, JSON, Object, Array, String, Number, Set, Map, isNaN, parseInt, parseFloat, Promise, Symbol, Proxy };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.__old;
}
