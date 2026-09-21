/* ---------------------------------------------------------------------
   dates.js — арифметика дат 'ГГГГ-ММ-ДД' для движка.

   Всё считается в UTC: переход на летнее время и часовой пояс устройства
   не сдвигают даты. Строки ISO сравниваются обычным < и >.
--------------------------------------------------------------------- */

const DAY_MS = 86400000;

export const pad2 = n => String(n).padStart(2, '0');

export function iso(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function parts(s) {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

function toUTC(s) {
  const { y, m, d } = parts(s);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  const dt = new Date(ms);
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function isValid(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromUTC(toUTC(s)) === s;
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(s, n) {
  return fromUTC(toUTC(s) + n * DAY_MS);
}

/* Сдвиг на k месяцев: { y, m } */
export function addMonths(y, m, k) {
  const idx = y * 12 + (m - 1) + k;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/* 0 — воскресенье, 6 — суббота */
export function dayOfWeek(s) {
  return new Date(toUTC(s)).getUTCDay();
}

/* Календарных дней между датами включительно; 0, если конец раньше начала */
export function daysInclusive(from, to) {
  if (!from || !to || to < from) return 0;
  return Math.round((toUTC(to) - toUTC(from)) / DAY_MS) + 1;
}

/* Пересечение двух отрезков дат: { from, to } или null */
export function overlap(aFrom, aTo, bFrom, bTo) {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  return from <= to ? { from, to } : null;
}

export function* eachDay(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export const ym = s => s.slice(0, 7);
export const monthStart = (y, m) => iso(y, m, 1);
export const monthEnd = (y, m) => iso(y, m, daysInMonth(y, m));

/* День месяца с ограничением длиной месяца: 31 → 28 в феврале */
export function clampDay(y, m, d) {
  return iso(y, m, Math.min(Math.max(1, d), daysInMonth(y, m)));
}

/* k месяцев перед месяцем (y, m), по порядку: [{ y, m }, ...] */
export function monthsBefore(y, m, k) {
  const out = [];
  for (let i = k; i >= 1; i--) out.push(addMonths(y, m, -i));
  return out;
}
