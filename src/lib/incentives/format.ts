/**
 * Display formatting for incentive figures. Formatting only — every number
 * passed in already came out of the engine.
 *
 * Pure + client-safe. Indian digit grouping, since plans are in ₹ L / ₹ Cr.
 */

import { Rational } from './rational';
import { canonicalDecimal } from './terms';

const nf = new Map<number, Intl.NumberFormat>();
function num(v: number, maxDp: number): string {
  let f = nf.get(maxDp);
  if (!f) {
    f = new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxDp, minimumFractionDigits: 0 });
    nf.set(maxDp, f);
  }
  return f.format(v);
}

/** ₹ Lakh, e.g. "₹5.4 L". */
export function fmtL(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `₹${num(v, dp)} L`;
}

/** ₹ Crore, e.g. "₹8.25 Cr". */
export function fmtCr(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `₹${num(v, dp)} Cr`;
}

/** A fraction as a percent, e.g. 0.6 → "60%". */
export function fmtPct(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${num(v * 100, dp)}%`;
}

/** Signed ₹ L delta, e.g. "+₹1 L". */
export function fmtDeltaL(v: number, dp = 2): string {
  if (v === 0) return '₹0 L';
  return `${v > 0 ? '+' : '−'}₹${num(Math.abs(v), dp)} L`;
}

export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Margin is typed as a percent ("18") and stored as a fraction ("0.18").
 * Converted exactly, so 18.5% is 0.185 and not 0.18500000000000002.
 */
export function percentToFraction(input: string): string {
  const s = input.trim();
  if (s === '') return '';
  try {
    return canonicalDecimal(Rational.parse(s).div(Rational.parse(100)).toFixed(9)) ?? '';
  } catch {
    return s;
  }
}

export function fractionToPercent(fraction: string | null | undefined): string {
  if (fraction == null || fraction === '') return '';
  try {
    return canonicalDecimal(Rational.parse(fraction).mul(Rational.parse(100)).toFixed(9)) ?? '';
  } catch {
    return '';
  }
}
