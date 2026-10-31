/* Переходящий через Новый год отпуск/лист относится только к году начала. */
export function leaveYears(rows, planYears = []) {
  return [...new Set([...planYears, ...rows.map(r => Number(String(r.start_date ?? '').slice(0, 4)))])]
    .filter(y => Number.isInteger(y) && y > 0 && y <= 9999).sort((a, b) => a - b);
}

export const inLeaveYear = (row, year) => String(row.start_date ?? '').slice(0, 4) === String(year);
