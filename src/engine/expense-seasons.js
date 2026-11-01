/* Ежегодные интервалы сумм. Границы включены, февраль допускает 29 число. */
import { daysInMonth } from './dates.js';

export function validMonthDay(value) {
  if (!/^\d{2}-\d{2}$/.test(value ?? '')) return false;
  const [month, day] = value.split('-').map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2000, month);
}

const ordinal = md => {
  const [month, day] = md.split('-').map(Number);
  return (Date.UTC(2000, month - 1, day) - Date.UTC(2000, 0, 1)) / 86400000;
};

export function validateAmountSeasons(seasons) {
  if (!Array.isArray(seasons) || seasons.length > 366) return 'Список сезонов некорректен';
  const used = new Set();
  for (const season of seasons) {
    if (!season || typeof season !== 'object' || Array.isArray(season)) return 'Список сезонов некорректен';
    if (!validMonthDay(season.from) || !validMonthDay(season.to)) return 'Укажите существующие даты в формате ММ-ДД';
    if (!Number.isFinite(season.amount) || season.amount < 0) return 'Сумма сезона должна быть неотрицательным числом';
    const from = ordinal(season.from), to = ordinal(season.to);
    for (let day = from;; day = (day + 1) % 366) {
      if (used.has(day)) return 'Сезоны одной суммы не должны пересекаться, включая граничные даты';
      used.add(day);
      if (day === to) break;
    }
  }
  return null;
}

export const containsMonthDay = (md, from, to) => from <= to ? md >= from && md <= to : md >= from || md <= to;

export function expenseAmountOn(row, date, amountKey = 'amount') {
  const md = date?.slice(5, 10);
  if (md && row.season_from && row.season_to && !containsMonthDay(md, row.season_from, row.season_to)) return 0;
  const season = md && (row.amount_seasons ?? []).find(s => containsMonthDay(md, s.from, s.to));
  return Number(season ? season.amount : row[amountKey]) || 0;
}
