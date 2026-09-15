/**
 * A `YYYY-MM-DD` as the Excel date for that calendar day (D167).
 *
 * Built at UTC midnight, because Excel stores a date as a day count with no
 * timezone and `exceljs` converts a JavaScript Date from its UTC value. A local
 * midnight would move every date a day earlier for anybody east of Greenwich
 * the moment the workbook was read back.
 *
 * Here rather than in the workbook service because it is a date helper, not a
 * query: nothing about it belongs to a user (CLAUDE.md §3).
 */
export function excelDate(localDate: string): Date {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}
