import { formatMetric, type MetricUnit } from '../metrics';

/**
 * Client-safe value formatting for the manager reports: the registry's
 * unit formatting with the workspace currency plugged in.
 */
export type CurrencyCtx = { code: string; locale: string };

export function currencyFormatter(c: CurrencyCtx, compact = false): (major: number) => string {
  let f: Intl.NumberFormat;
  try {
    f = new Intl.NumberFormat(c.locale, {
      style: 'currency',
      currency: c.code,
      maximumFractionDigits: compact ? 1 : 0,
      notation: compact ? 'compact' : 'standard',
    });
  } catch {
    f = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  }
  return (v) => f.format(v);
}

export function fmt(unit: MetricUnit, value: number | null, c: CurrencyCtx, compact = false): string {
  return formatMetric(unit, value, currencyFormatter(c, compact));
}

/** "+12.5%" / "−3" style change text; direction carried by sign and arrow, never colour alone. */
export function changeLabel(absolute: number | null, percent: number | null, unit: MetricUnit, c: CurrencyCtx): string {
  if (absolute === null) return 'no comparison';
  if (absolute === 0) return 'no change';
  const arrow = absolute > 0 ? '▲' : '▼';
  const abs = fmt(unit, Math.abs(absolute), c, true);
  return `${arrow} ${absolute > 0 ? '+' : '−'}${abs}${percent !== null ? ` (${percent > 0 ? '+' : ''}${percent}%)` : ''}`;
}
