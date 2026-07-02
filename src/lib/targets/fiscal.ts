/**
 * Fiscal-year helpers for sales targets. The workspace fiscal year starts in
 * `startMonth` (1–12, from organization_settings.fiscal_year_start_month). A
 * `fiscalYear` value is the STARTING calendar year — e.g. with an April start,
 * fiscalYear 2026 spans 1 Apr 2026 → 31 Mar 2027.
 *
 * Pure + client-safe (no DB, no server-only). Callers pass `now` explicitly.
 */

/** The fiscal year that the given date falls into. */
export function currentFiscalYear(startMonth: number, now: Date): number {
  const month = now.getMonth() + 1; // 1–12
  const year = now.getFullYear();
  return month >= startMonth ? year : year - 1;
}

/** Half-open [start, end) UTC window for a fiscal year. */
export function fiscalYearRange(
  startMonth: number,
  fiscalYear: number,
): { start: Date; end: Date } {
  const start = new Date(Date.UTC(fiscalYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(fiscalYear + 1, startMonth - 1, 1));
  return { start, end };
}

/** Human label: "2026" for a Jan start, else "FY2026–27". */
export function fiscalYearLabel(startMonth: number, fiscalYear: number): string {
  if (startMonth === 1) return String(fiscalYear);
  const next = String((fiscalYear + 1) % 100).padStart(2, '0');
  return `FY${fiscalYear}–${next}`;
}

/** A small window of selectable fiscal years around the current one. */
export function fiscalYearChoices(
  startMonth: number,
  now: Date,
  opts: { back?: number; forward?: number } = {},
): number[] {
  const back = opts.back ?? 2;
  const forward = opts.forward ?? 1;
  const current = currentFiscalYear(startMonth, now);
  const years: number[] = [];
  for (let y = current - back; y <= current + forward; y++) years.push(y);
  return years;
}
