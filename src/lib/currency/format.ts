import type { OrganizationSettings } from '@/db/schema';

/**
 * Centralized tenant-aware currency formatting. All money in the
 * product flows through these helpers — no hardcoded `$` literals,
 * no per-call-site `Intl.NumberFormat` instantiation.
 *
 * SSR safety: every formatter is constructed with the org's locale +
 * currency, NOT the runtime's locale. That means the server and the
 * client agree on the output byte-for-byte; no hydration mismatch.
 *
 * Performance: `Intl.NumberFormat` instances are expensive to
 * construct. We cache by `(locale, currency, notation, compact)` so
 * a 50-row table renders against one formatter, not 50.
 */

export type TenantCurrencyContext = Pick<
  OrganizationSettings,
  'defaultCurrency' | 'currencyLocale' | 'compactNumbers'
>;

const CACHE = new Map<string, Intl.NumberFormat>();

function formatterKey(
  locale: string,
  currency: string,
  notation: 'standard' | 'compact',
  maxFractionDigits: number,
): string {
  return `${locale}|${currency}|${notation}|${maxFractionDigits}`;
}

function getFormatter(
  locale: string,
  currency: string,
  notation: 'standard' | 'compact',
  maxFractionDigits: number,
): Intl.NumberFormat {
  const key = formatterKey(locale, currency, notation, maxFractionDigits);
  let fmt = CACHE.get(key);
  if (fmt) return fmt;
  fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation,
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: 0,
  });
  CACHE.set(key, fmt);
  return fmt;
}

/**
 * Format a minor-units amount in the tenant's currency + locale.
 *
 * Example: formatTenantCurrency(5120000_00, { defaultCurrency: 'INR',
 * currencyLocale: 'en-IN' }) → "₹51,20,000.00".
 */
export function formatTenantCurrency(
  amountMinor: number | null | undefined,
  ctx: TenantCurrencyContext,
  options?: {
    /** Maximum decimal places. Default 0 for whole-unit display. */
    maxFractionDigits?: number;
    /** Override the currency for this call (e.g. legacy per-deal currency). */
    currency?: string;
  },
): string {
  const amount = (amountMinor ?? 0) / 100;
  const currency =
    options?.currency?.toUpperCase() ||
    ctx.defaultCurrency.toUpperCase() ||
    'USD';
  const locale = ctx.currencyLocale || 'en-US';
  const fmt = getFormatter(
    locale,
    currency,
    'standard',
    options?.maxFractionDigits ?? 0,
  );
  return fmt.format(amount);
}

/**
 * Compact tenant-currency formatter. Returns "₹51L" / "$1.2M" / "€84.5K".
 * Same caching contract as the standard formatter.
 *
 * Falls back to the standard formatter when `compactNumbers === false`
 * on the tenant's settings, so callers can use this everywhere a
 * tight display is preferred and let the org preference drive it.
 */
export function formatCompactTenantCurrency(
  amountMinor: number | null | undefined,
  ctx: TenantCurrencyContext,
  options?: {
    /** Force compact regardless of tenant preference. */
    force?: boolean;
    currency?: string;
  },
): string {
  if (!ctx.compactNumbers && !options?.force) {
    return formatTenantCurrency(amountMinor, ctx, { currency: options?.currency });
  }
  const amount = (amountMinor ?? 0) / 100;
  const currency =
    options?.currency?.toUpperCase() ||
    ctx.defaultCurrency.toUpperCase() ||
    'USD';
  const locale = ctx.currencyLocale || 'en-US';
  const fmt = getFormatter(locale, currency, 'compact', 1);
  return fmt.format(amount);
}

/**
 * Just the locale-aware currency symbol for the tenant. Useful for
 * input prefixes ("₹" / "$" / "€") without dragging the amount.
 */
export function tenantCurrencySymbol(ctx: TenantCurrencyContext): string {
  const fmt = getFormatter(
    ctx.currencyLocale || 'en-US',
    ctx.defaultCurrency.toUpperCase() || 'USD',
    'standard',
    0,
  );
  const parts = fmt.formatToParts(0);
  const symbolPart = parts.find((p) => p.type === 'currency');
  return symbolPart?.value ?? '$';
}

/** Locale-aware integer formatter (no currency). Reuses the cache for {locale}|number. */
export function formatTenantNumber(
  value: number,
  ctx: TenantCurrencyContext,
  options?: { maxFractionDigits?: number },
): string {
  const locale = ctx.currencyLocale || 'en-US';
  const key = `${locale}|__number|${options?.maxFractionDigits ?? 0}`;
  let fmt = CACHE.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      maximumFractionDigits: options?.maxFractionDigits ?? 0,
    });
    CACHE.set(key, fmt);
  }
  return fmt.format(value);
}

/**
 * Common currency catalog for the settings picker. Three-letter
 * ISO 4217 codes; the order is "default + your most likely
 * tenants" not strict alphabetical.
 */
export const SUPPORTED_CURRENCIES: ReadonlyArray<{
  code: string;
  label: string;
  defaultLocale: string;
}> = [
  { code: 'USD', label: 'US Dollar', defaultLocale: 'en-US' },
  { code: 'INR', label: 'Indian Rupee', defaultLocale: 'en-IN' },
  { code: 'EUR', label: 'Euro', defaultLocale: 'en-IE' },
  { code: 'GBP', label: 'British Pound', defaultLocale: 'en-GB' },
  { code: 'AED', label: 'UAE Dirham', defaultLocale: 'en-AE' },
  { code: 'SGD', label: 'Singapore Dollar', defaultLocale: 'en-SG' },
  { code: 'CAD', label: 'Canadian Dollar', defaultLocale: 'en-CA' },
  { code: 'AUD', label: 'Australian Dollar', defaultLocale: 'en-AU' },
  { code: 'JPY', label: 'Japanese Yen', defaultLocale: 'ja-JP' },
];

/** Locale catalog matched to the currencies above (extensible). */
export const SUPPORTED_LOCALES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en-US', label: 'English (United States)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
  { code: 'en-IE', label: 'English (Ireland)' },
  { code: 'en-AE', label: 'English (UAE)' },
  { code: 'en-SG', label: 'English (Singapore)' },
  { code: 'en-CA', label: 'English (Canada)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'ja-JP', label: 'Japanese (Japan)' },
];
