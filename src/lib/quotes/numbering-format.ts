/**
 * Pure quote-number formatting (no DB): safe to import from client
 * components (the Quotes settings page shows a live example).
 */
export type QuoteNumberFormat = {
  prefix: string;
  separator: string;
  includeFiscalYear: boolean;
  padding: number;
};

/** startMonth 1 -> calendar year ('2026'); otherwise '2026-27'. isoDate is YYYY-MM-DD. */
export function fiscalYearLabel(isoDate: string, startMonth: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  if (startMonth <= 1) return String(year);
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function formatQuoteNumber(
  fmt: QuoteNumberFormat,
  fyLabel: string | null,
  seq: number,
): string {
  const parts = [fmt.prefix];
  if (fmt.includeFiscalYear && fyLabel) parts.push(fyLabel);
  parts.push(String(seq).padStart(fmt.padding, '0'));
  return parts.join(fmt.separator);
}
