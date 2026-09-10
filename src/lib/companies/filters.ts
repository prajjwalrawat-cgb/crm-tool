/**
 * Client- and server-safe filter shape for the Companies page.
 * Mirrors `lib/deals/filters.ts`: no `server-only` imports so client
 * components (filter bar) can use these helpers freely.
 *
 * URL contract:
 *   hasDeals=1            companies with at least one open deal
 *   recentActivityDays=14 companies with any activity in the last N days
 *   createdWithinDays=30  created in the last N days
 *   stale=1               no activity within `staleDays` (default 30)
 *   staleDays=60
 *   minOpen=250000        open pipeline >= this many MAJOR units
 *   minWon=1000000        won lifetime value >= this many MAJOR units
 *
 * `hasDeals`, `recentActivityDays` and `stale` are all evaluated against
 * the `company_rollups` columns the table itself renders (migration
 * 0065), not against a parallel definition. Before that they were
 * separate EXISTS subqueries over `activity_logs`, so a chip could
 * disagree with the row beside it and there was no way to tell from the
 * screen which one was lying.
 *
 * `minOpen` / `minWon` are the value-threshold half of "filter on
 * open_pipeline_value and won_lifetime_value independently". They take
 * MAJOR units (rupees, dollars) because they ride a user-visible URL;
 * the query layer converts to the minor units the column stores.
 */

export type CompanyFilters = {
  hasDeals?: boolean;
  recentActivityDays?: number;
  createdWithinDays?: number;
  stale?: boolean;
  staleDays?: number;
  mine?: boolean;
  unassigned?: boolean;
  /** Open pipeline floor, MAJOR units. */
  minOpen?: number;
  /** Won lifetime floor, MAJOR units. */
  minWon?: number;
};

/**
 * Sort modes. Each is a keyset mode, not a free "order by any column":
 * every one of them needs its own cursor predicate and its own index
 * story, so the set is closed and the parser rejects anything else.
 *
 *   recent    companies.created_at        (default — unchanged behaviour)
 *   deals     rollup.deal_count
 *   pipeline  rollup.open_pipeline_value
 *   won       rollup.won_lifetime_value
 *   activity  rollup.last_activity_at
 */
export const COMPANY_SORTS = [
  'recent',
  'deals',
  'pipeline',
  'won',
  'activity',
] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

export type SortDir = 'asc' | 'desc';

/** URL keys owned by sorting, so "Clear all" and the search box can wipe them. */
export const COMPANY_SORT_URL_KEYS = ['sort', 'dir'] as const;

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
    mine: numFlag(raw.mine),
    unassigned: numFlag(raw.unassigned),
    minOpen: numVal(raw.minOpen),
    minWon: numVal(raw.minWon),
  };
}

/**
 * `sort` and `dir` are parsed together because a direction without a
 * recognised mode is meaningless, and an unrecognised mode must fall all
 * the way back to the default rather than half-applying. Each mode
 * carries its own natural default direction: money and activity are
 * interesting from the top, so they start descending — which is also
 * what `recent` has always done.
 */
export function parseCompanySort(
  raw: Partial<Record<string, string | string[] | undefined>>,
): { sort: CompanySort; dir: SortDir } {
  const rawSort = typeof raw.sort === 'string' ? raw.sort : '';
  const sort = (COMPANY_SORTS as readonly string[]).includes(rawSort)
    ? (rawSort as CompanySort)
    : 'recent';
  const dir: SortDir = raw.dir === 'asc' ? 'asc' : 'desc';
  return { sort, dir };
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
  if (filters.mine) out.set('mine', '1');
  if (filters.unassigned) out.set('unassigned', '1');
  if (filters.minOpen) out.set('minOpen', String(filters.minOpen));
  if (filters.minWon) out.set('minWon', String(filters.minWon));
  return out;
}

export function hasActiveCompanyFilters(filters: CompanyFilters): boolean {
  return Boolean(
    filters.hasDeals ||
      filters.recentActivityDays ||
      filters.createdWithinDays ||
      filters.stale ||
      filters.mine ||
      filters.unassigned ||
      filters.minOpen ||
      filters.minWon,
  );
}

/** Default staleness window, shared by the chip label and the query. */
export const DEFAULT_STALE_DAYS = 30;
