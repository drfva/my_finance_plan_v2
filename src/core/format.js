/* ---------------------------------------------------------------------
   format.js — деньги, числа, даты и склонения.

   Ничего не знает о рублях и русском языке: локаль, валюта и шаг округления
   приходят из настроек (core/config.js). Все функции чистые.

     const fmt = createFormat({ locale: 'ru-RU', currency: 'RUB', rounding: 1, currencies });
     fmt.money(12345.6)            → '12 346 ₽'
     fmt.money(100, 'USD')         → '100 $'
     fmt.date('2027-01-05')        → '05.01.2027'
     fmt.plural(5, { one: 'выплата', few: 'выплаты', many: 'выплат' }) → 'выплат'
--------------------------------------------------------------------- */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM = /^(\d{4})-(\d{2})$/;

/* Дата 'ГГГГ-ММ-ДД' → Date в местном времени. new Date('2027-01-05') дал бы
   полночь по UTC, и в часовых поясах западнее Гринвича получилось бы 4 января. */
export function parseISODate(iso) {
  const m = ISO_DATE.exec(String(iso ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

export function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayISO(now = new Date()) {
  return toISODate(now);
}

/* Сколько знаков после запятой даёт шаг округления: 1 → 0, 0.01 → 2, 100 → 0 */
function decimalsOf(step) {
  if (!(step > 0) || step >= 1) return 0;
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return (s.split('.')[1] || '').length;
}

export function createFormat({ locale = 'ru-RU', currency = 'RUB', rounding = 1, currencies = [] } = {}) {
  const step = Number(rounding) > 0 ? Number(rounding) : 1;
  const decimals = decimalsOf(step);
  const symbols = new Map(currencies.map(c => [c.code, c.symbol]));

  const numberFmt = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  const plurals = new Intl.PluralRules(locale);
  const cache = new Map();
  function intl(key, make) {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key);
  }

  /* Округление по настройке rounding. toFixed убирает хвосты вроде 0.30000000000000004 */
  function round(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number((Math.round(n / step) * step).toFixed(decimals));
  }

  function number(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (digits === undefined) return numberFmt.format(round(n));
    return intl(`n${digits}`, () => new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0, maximumFractionDigits: digits,
    })).format(n);
  }

  /* Сумма с символом валюты. Символ берётся из справочника ref_currencies,
     поэтому новая валюта — строка в таблице, а не правка кода. */
  function money(value, code = currency, { sign = false } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const r = round(n);
    const body = numberFmt.format(Math.abs(r));
    const symbol = symbols.get(code) ?? code;
    const prefix = r < 0 ? '−' : (sign && r > 0 ? '+' : '');
    return `${prefix}${body} ${symbol}`;
  }

  /* Процент из числа процентов: 13 → '13 %' (по правилам локали) */
  function percent(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return intl(`p${digits}`, () => new Intl.NumberFormat(locale, {
      style: 'percent', maximumFractionDigits: digits,
    })).format(n / 100);
  }

  const DATE_STYLES = {
    short:    { day: '2-digit', month: '2-digit', year: 'numeric' },   // 05.01.2027
    dayMonth: { day: '2-digit', month: '2-digit' },                     // 05.01
    long:     { day: 'numeric', month: 'long', year: 'numeric' },      // 5 января 2027 г.
    dayLong:  { day: 'numeric', month: 'long' },                        // 5 января
    weekday:  { weekday: 'long', day: 'numeric', month: 'long' },      // вторник, 5 января
  };

  function date(iso, style = 'short') {
    const d = parseISODate(iso);
    if (!d) return iso ? String(iso) : '';
    const opts = DATE_STYLES[style] ?? DATE_STYLES.short;
    return intl(`d:${style}`, () => new Intl.DateTimeFormat(locale, opts)).format(d);
  }

  /* 'ГГГГ-ММ' → 'январь 2027' */
  function month(ym, { withYear = true } = {}) {
    const m = YM.exec(String(ym ?? ''));
    if (!m) return String(ym ?? '');
    const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    const opts = withYear ? { month: 'long', year: 'numeric' } : { month: 'long' };
    const text = intl(`m:${withYear}`, () => new Intl.DateTimeFormat(locale, opts)).format(d);
    return withYear ? text.replace(/\s?г\.$/, '') : text;
  }

  /* Название месяца по номеру 1–12, в именительном падеже */
  function monthName(m) {
    return month(`2000-${String(m).padStart(2, '0')}`, { withYear: false });
  }

  /* Склонение по правилам локали: русский — one/few/many, английский — one/other.
     Если нужной формы нет, берётся other, затем many. */
  function plural(n, forms) {
    const cat = plurals.select(Math.abs(Number(n)));
    return forms[cat] ?? forms.other ?? forms.many ?? forms.one ?? '';
  }

  function count(n, forms) {
    return `${number(n, 0)} ${plural(n, forms)}`;
  }

  /* Разбор введённого числа: '1 234,5' / '1,234.5' / '−500' → число или null */
  function parseNumber(text) {
    if (typeof text === 'number') return Number.isFinite(text) ? text : null;
    let s = String(text ?? '').trim().replace(/[\s  ]/g, '').replace(/[−–]/g, '-');
    if (!s) return null;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      // десятичный разделитель — тот, что правее
      s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma > -1) {
      s = s.replace(',', '.');
    }
    if (!/^-?\d*\.?\d+$/.test(s) && !/^-?\d+\.?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function parseMoney(text) {
    const n = parseNumber(text);
    return n === null ? null : round(n);
  }

  return Object.freeze({
    locale, currency, rounding: step,
    round, number, money, percent, date, month, monthName, plural, count,
    parseNumber, parseMoney, parseISODate, toISODate, todayISO,
  });
}
