/* Пособия по временной нетрудоспособности. Все суммы базы — до НДФЛ.
   Обычная болезнь, бытовая травма, уход; особые случаи — подтверждённые суммы.
   Параметры неизвестного года не наследуются молча от предыдущего. */
import { eachDay, daysInMonth, daysInclusive, isValid } from './dates.js';

export const SICK_MROT = { 2025: 22440, 2026: 27093 };
export const SICK_CAPS = { 2023: 1917000, 2024: 2225000, 2025: 2759000, 2026: 2979000 };
export const sickPeriodId = (id, payer) => `sick:${id}:${payer}`;
const cents = n => Math.round((n + Number.EPSILON) * 100) / 100;
const present = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
const nonnegative = n => present(n) && Number(n) >= 0;
const finish = out => {
  for (const payer of ['employer', 'sfr']) {
    const net = out.leave[`${payer}_net`];
    const gross = payer === 'employer' ? out.employerGross : out.sfrGross;
    if (net != null && (!nonnegative(net) || Number(net) > gross)) out.errors.push('Подтверждённая сумма на руки должна быть от нуля до начисленной суммы. Проверьте начисление или выберите особый случай.');
  }
  return out;
};

export function sickParameters(s) {
  const year = Number((s.case_start_date || s.start_date || '').slice(0, 4));
  const year1 = Number(s.base_year1 || year - 2);
  const year2 = Number(s.base_year2 || year - 1);
  return { year, year1, year2, mrot: s.mrot ?? SICK_MROT[year],
    cap1: s.cap1 ?? SICK_CAPS[year1], cap2: s.cap2 ?? SICK_CAPS[year2],
    // Ограничение дневного заработка — по двум годам перед страховым случаем,
    // даже если расчётные годы заменены из-за декрета.
    maxBase: s.max_base ?? ((SICK_CAPS[year - 2] && SICK_CAPS[year - 1])
      ? SICK_CAPS[year - 2] + SICK_CAPS[year - 1] : undefined) };
}

export function sickFormula(s, { vacations = [], used = new Map() } = {}) {
  const params = sickParameters(s);
  const errors = [];
  const warnings = [];
  const out = { leave: s, params, errors, warnings, days: [], employerGross: 0, sfrGross: 0, paidDays: 0 };
  if (!s.benefit_enabled) return { ...out, disabled: true };
  if (!isValid(s.start_date || '') || !isValid(s.end_date || '') || s.end_date < s.start_date) {
    errors.push('Укажите корректные начало и конец больничного.'); return out;
  }
  const count = daysInclusive(s.start_date, s.end_date);
  if (count > 1096) { errors.push('Проверьте даты: один лист не должен охватывать больше трёх лет.'); return out; }
  if (s.reason === 'manual') {
    if (!nonnegative(s.employer_gross) || !nonnegative(s.sfr_gross)) errors.push('Укажите обе подтверждённые начисленные суммы, включая ноль.');
    else { out.employerGross = cents(Number(s.employer_gross)); out.sfrGross = cents(Number(s.sfr_gross)); }
    warnings.push('Особый случай: суммы и право на оплату подтверждаются отдельно; автоматическая формула не применяется.');
    return finish(out);
  }
  if (!['illness', 'child', 'family'].includes(s.reason)) errors.push('Выберите причину больничного.');
  const years = Number(s.insurance_years), months = Number(s.insurance_months ?? 0);
  if (!nonnegative(s.insurance_years) || !Number.isInteger(years) || !Number.isInteger(months) || months < 0 || months > 11) errors.push('Укажите страховой стаж на начало случая: полные годы и от 0 до 11 месяцев.');
  if (!nonnegative(s.earnings1) || !nonnegative(s.earnings2)) errors.push('Укажите заработок за оба расчётных года; отсутствие заработка обозначьте нулём.');
  if (![params.mrot, params.cap1, params.cap2, params.maxBase].every(n => present(n) && Number(n) > 0)) errors.push('Для выбранных годов укажите МРОТ, две предельные базы и максимальную базу двух лет перед случаем.');
  if (![params.year, params.year1, params.year2].every(Number.isInteger) || params.year1 >= params.year || params.year2 >= params.year || params.year1 === params.year2 || params.year1 > params.year2) errors.push('Расчётные годы должны быть разными, последовательность — от раннего к позднему, оба до года случая.');
  if ((params.year1 !== params.year - 2 || params.year2 !== params.year - 1) && !s.replacement_confirmed) errors.push('Подтвердите основание для замены расчётных лет.');
  const district = Number(s.district_coefficient ?? 1), fraction = Number(s.employment_fraction ?? 1);
  if (!(district >= 1 && district <= 5) || !(fraction > 0 && fraction <= 1)) errors.push('Проверьте районный коэффициент (от 1) и долю ставки (больше 0, не больше 1).');
  const excluded = Number(s.excluded_days ?? 0), prior = Number(s.prior_case_days ?? 0), baseline = Number(s.used_days ?? 0);
  if (![excluded, prior, baseline].every(n => Number.isInteger(n) && n >= 0) || excluded >= 730) errors.push('Количество дней должно быть целым и неотрицательным; исключаемых дней — меньше 730.');
  if (s.case_start_date && (!isValid(s.case_start_date) || s.case_start_date > s.start_date)) errors.push('Начало страхового случая не может быть позже начала листа.');
  const child = s.reason === 'child';
  const age = Number(s.child_age);
  if (child && (!nonnegative(s.child_age) || !Number.isInteger(age) || age >= 18)) errors.push('Укажите возраст ребёнка на начало случая: от 0 до 17 лет.');
  if ((child || s.reason === 'family') && !String(s.recipient || '').trim()) errors.push('Укажите, за кем ухаживаете: одинаковое имя связывает годовой лимит разных листов.');
  if ((child || s.reason === 'family') && !['outpatient', 'inpatient'].includes(s.treatment)) errors.push('Выберите условия лечения.');
  if (errors.length) return out;
  const staffRate = years * 12 + months >= 96 ? 1 : years * 12 + months >= 60 ? 0.8 : 0.6;
  const smallChild = child && age < 8;
  const denominator = 730 - excluded;
  const base = Math.min(Number(s.earnings1), Number(params.cap1)) + Math.min(Number(s.earnings2), Number(params.cap2));
  // Районный коэффициент включается в минимум, но не умножает повторно фактическую зарплату.
  const daily = cents(Math.min(Number(params.maxBase) / 730,
    Math.max(base / denominator, Number(params.mrot) * 24 / 730 * district * fraction)));
  Object.assign(out, { base, denominator, daily, staffRate, count });
  if (s.replacement_confirmed) warnings.push('Замена лет допустима по заявлению при установленных законом основаниях и увеличении пособия.');
  if (excluded) warnings.push('Из 730 исключаются только предусмотренные законом периоды приостановления договора/службы, не обычные отпуска и больничные.');
  const category = s.child_category || 'usual';
  if (child && !['usual', 'special_list', 'disabled', 'unlimited', 'unlimited_any'].includes(category)) errors.push('Проверьте категорию ухода за ребёнком.');
  let annual = Infinity, perCase = Infinity;
  if (child) {
    if (category === 'disabled') annual = 120;
    else if (category === 'unlimited_any') { /* специальная категория без годового лимита */ }
    else if (category === 'unlimited') {
      if (s.treatment !== 'inpatient') errors.push('Для этой категории укажите стационар или используйте подтверждённые суммы особого случая.');
    } else if (age < 7) annual = category === 'special_list' ? 90 : 60;
    else if (age < 15) { annual = 45; perCase = 15; }
    else { annual = 30; perCase = 7; }
  } else if (s.reason === 'family') { annual = 30; perCase = 7; }
  if (errors.length) return out;
  let index = 0;
  for (const date of eachDay(s.start_date, s.end_date)) {
    const year = date.slice(0, 4);
    const key = `${s.recipient?.trim().toLocaleLowerCase('ru-RU')}|${year}`;
    const already = (year === s.start_date.slice(0, 4) ? baseline : 0) + (used.get(key) ?? 0);
    const onVacation = vacations.some(v => v.start_date && v.end_date && v.start_date <= date && date <= v.end_date);
    const care = child || s.reason === 'family';
    const available = !care || (already < annual && prior + index < perCase
      && !onVacation && !((s.reason === 'family' || (child && age >= 15 && category === 'usual')) && s.treatment === 'inpatient'));
    let rate = smallChild ? 1 : staffRate;
    if (child && !smallChild && s.treatment === 'outpatient' && prior + index >= 10) rate = 0.5;
    const dim = daysInMonth(Number(year), Number(date.slice(5, 7)));
    const floor = Number(params.mrot) * district * fraction / dim;
    let amount = Math.max(daily * rate, floor);
    if (years * 12 + months < 6 && !smallChild) amount = Math.min(amount, floor);
    // Минимум МРОТ/дней месяца сохраняем без промежуточного округления:
    // иначе полный февраль может превысить месячный предел на несколько копеек.
    amount = available ? amount : 0;
    const payer = s.reason === 'illness' && prior + index < 3 ? 'employer' : 'sfr';
    out.days.push({ date, payer, amount, rate, paid: available });
    if (available) {
      out.paidDays++;
      if (care) used.set(key, (used.get(key) ?? 0) + 1);
    }
    index++;
  }
  out.employerGross = cents(out.days.filter(d => d.payer === 'employer').reduce((n, d) => n + d.amount, 0));
  out.sfrGross = cents(out.days.filter(d => d.payer === 'sfr').reduce((n, d) => n + d.amount, 0));
  if (out.paidDays < count) warnings.push('Часть дней не оплачивается: лимит ухода, условия лечения или совпадение с отпуском.');
  if (s.reason === 'illness' && vacations.some(v => v.start_date <= s.end_date && v.end_date >= s.start_date)) warnings.push('Болезнь совпала с отпуском: согласуйте продление/перенос и исправьте даты отпуска в плане.');
  if (out.days.some(d => d.date.slice(0, 4) !== String(params.year))) warnings.push('Лист пересекает границу года: база и стаж относятся к началу страхового случая. Проверьте МРОТ и подтверждённые суммы.');
  return finish(out);
}

export function computeSickLeaves(inc) {
  const used = new Map();
  const occupied = new Set();
  return [...(inc.sick_leaves ?? [])].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)) || String(a.id).localeCompare(String(b.id)))
    .map(s => {
      const nextUsed = new Map(used);
      const f = sickFormula(s, { vacations: inc.vacations ?? [], used: nextUsed });
      if (f.disabled || f.errors.length) return f;
      const dates = [...eachDay(s.start_date, s.end_date)];
      if (dates.some(d => occupied.has(d))) {
        f.errors.push('Даты пересекаются с другим рассчитываемым больничным. Исправьте пересечение, чтобы не начислить пособие дважды.');
        return f;
      }
      for (const [key, value] of nextUsed) used.set(key, value);
      for (const date of dates) occupied.add(date);
      return f;
    });
}

/* Реальные строки выплат сохраняются в БД, чтобы отчисления и фиксация истории
   могли ссылаться на них обычными внешними ключами. Закреплённые не перестраиваем. */
export function sickPeriods(inc, formulas) {
  const expected = new Map();
  for (const f of formulas) {
    if (f.disabled || f.errors.length) continue;
    const s = f.leave;
    for (const payer of ['employer', 'sfr']) {
      const gross = payer === 'employer' ? f.employerGross : f.sfrGross;
      const date = s[`${payer}_pay_date`];
      if (!(gross > 0) || !isValid(date || '') || date < s.start_date) continue;
      const id = sickPeriodId(s.id, payer);
      expected.set(id, { id, year: Number(date.slice(0, 4)), slot_order: null,
        title: `Больничный · ${payer === 'employer' ? 'работодатель' : 'СФР'}`,
        pay_date: date, window_start: date, window_end: date, calc_mode: 'manual', manual_kind: null,
        taxable: true, income_manual: false, income_net: 0, locked: false, note: '',
        sick_leave_id: s.id, sick_payer: payer, sick_gross: gross });
    }
  }
  const periods = [];
  for (const p of inc.periods ?? []) {
    if (!p.sick_leave_id || p.locked) { periods.push(p); expected.delete(p.id); continue; }
    const next = expected.get(p.id);
    if (next) periods.push({ ...p, ...next });
    expected.delete(p.id);
  }
  return [...periods, ...expected.values()];
}
