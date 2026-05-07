export const KNOWN_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'INR',
  'CAD',
  'AUD',
  'JPY',
] as const;

export type KnownCurrency = (typeof KNOWN_CURRENCIES)[number];

const DECIMALS: Record<KnownCurrency, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

export function getCurrencyDecimals(code: string): number {
  return DECIMALS[code as KnownCurrency] ?? 2;
}

/**
 * Convert a major-units amount (e.g. dollars) to integer minor units (cents).
 * Math.round defends against the IEEE-754 rounding you get from `1.005 * 100`.
 */
export function toMinorUnits(amount: number, currency: string): number {
  const decimals = getCurrencyDecimals(currency);
  return Math.round(amount * 10 ** decimals);
}

export function fromMinorUnits(minor: number, currency: string): number {
  const decimals = getCurrencyDecimals(currency);
  return minor / 10 ** decimals;
}

const formatters = new Map<string, Intl.NumberFormat>();

export function formatCurrency(
  minor: number | bigint | null | undefined,
  currency: string,
): string {
  if (minor === null || minor === undefined) return '—';
  const code = currency.toUpperCase();
  let formatter = formatters.get(code);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: getCurrencyDecimals(code),
      maximumFractionDigits: getCurrencyDecimals(code),
    });
    formatters.set(code, formatter);
  }
  const major = typeof minor === 'bigint' ? Number(minor) : minor;
  return formatter.format(fromMinorUnits(major, code));
}
