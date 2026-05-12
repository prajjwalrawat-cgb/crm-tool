/**
 * Client- and server-safe filter shape for the Companies page.
 * Mirrors `lib/deals/filters.ts`: no `server-only` imports so client
 * components (filter bar) can use these helpers freely.
 *
 * URL contract:
 *   hasDeals=1            companies with at least one active deal
 *   recentActivityDays=14 companies with any activity in the last N days
 *   createdWithinDays=30  created in the last N days
 *   stale=1               no activity within `staleDays` (default 30)
 *   staleDays=60
 */

export type CompanyFilters = {
  hasDeals?: boolean;
  recentActivityDays?: number;
  createdWithinDays?: number;
  stale?: boolean;
  staleDays?: number;
};

const numFlag = (v: string | string[] | undefined): boolean =>
  v === '1' || v === 'true';

const numVal = (
  v: string | string[] | undefined,
): number | undefined => {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function parseCompanyFilters(
  raw: Partial<Record<string, string | string[] | undefined>>,
): CompanyFilters {
  return {
    hasDeals: numFlag(raw.hasDeals),
    recentActivityDays: numVal(raw.recentActivityDays),
    createdWithinDays: numVal(raw.createdWithinDays),
    stale: numFlag(raw.stale),
    staleDays: numVal(raw.staleDays),
  };
}

export function companyFiltersToSearchParams(
  filters: CompanyFilters,
): URLSearchParams {
  const out = new URLSearchParams();
  if (filters.hasDeals) out.set('hasDeals', '1');
  if (filters.recentActivityDays) {
    out.set('recentActivityDays', String(filters.recentActivityDays));
  }
  if (filters.createdWithinDays) {
    out.set('createdWithinDays', String(filters.createdWithinDays));
  }
  if (filters.stale) {
    out.set('stale', '1');
    if (filters.staleDays && filters.staleDays !== 30) {
      out.set('staleDays', String(filters.staleDays));
    }
  }
  return out;
}

export function hasActiveCompanyFilters(filters: CompanyFilters): boolean {
  return Boolean(
    filters.hasDeals ||
      filters.recentActivityDays ||
      filters.createdWithinDays ||
      filters.stale,
  );
}
