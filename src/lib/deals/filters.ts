import { DEAL_FIELD_SPECS } from './completeness';
import { type DealStage, DEAL_STAGES } from './schema';

/**
 * Client- and server-safe filter helpers for the deals page. Kept
 * separate from `queries.ts` (which is `server-only`) so client
 * components — the filter bar, future Cmd+K filter chips — can import
 * the URL parsing / serialization helpers without dragging the
 * Postgres client into the browser bundle.
 *
 * URL contract:
 *   stage=lead,qualified       — comma list of stages (multi-select)
 *   amountMin=1000             — amount lower bound (amount_minor units)
 *   amountMax=50000            — amount upper bound
 *   closeFrom=YYYY-MM-DD       — expected_close_date >= ...
 *   closeTo=YYYY-MM-DD         — expected_close_date <= ...
 *   stale=1                    — active deals with updated_at older than
 *                                14 days (or `staleDays`)
 *   staleDays=30               — override the staleness threshold
 *   companyId=<uuid1>,<uuid2>  — comma list of companies (multi-select)
 *   owner=<uuid1>,<uuid2>      — comma list of owners (multi-select)
 *   missing=next_step          — deals that OWE a completeness field at
 *                                their current stage and don't have it
 *   risk=high|elevated         — Phase 1 deal risk band and above
 *   offering=<uuid1>,<uuid2>   — deals tagged with ANY of these offerings
 *   uncategorized=1            — deals carrying NO offering tag at all
 *
 * Within a filter group the SQL is OR (e.g. `stage IN (...)`); between
 * groups it's AND. Multi-value keys are intentionally comma-joined
 * rather than repeated (`?stage=a&stage=b`) so URLs stay short and
 * `new URLSearchParams(qs)` round-trips cleanly.
 *
 * Any unknown key is preserved unchanged by the filter bar — search
 * (`q`) and pagination (`cursor`, `size`) live in the same URL and
 * are not part of this module.
 */

export type DealFilters = {
  stages?: DealStage[];
  amountMinorMin?: number;
  amountMinorMax?: number;
  expectedCloseFrom?: string;
  expectedCloseTo?: string;
  stale?: boolean;
  staleDays?: number;
  companyIds?: string[];
  /** `mine` and `unassigned` are resolved server-side using the current user. */
  mine?: boolean;
  unassigned?: boolean;
  /** Filter to deals owned by these teammates (OR within the group). */
  ownerIds?: string[];
  /** Won deals still awaiting manager approval (stage=won + pending). */
  awaitingApproval?: boolean;
  /** Won deals that have been manager-approved (stage=won + approved). */
  approvedOnly?: boolean;
  /** Health-score band filter (Module 2): matches deals.health_band. */
  score?: 'strong' | 'moderate' | 'at_risk';
  /** Held deals whose revisit date has arrived (Module 6). */
  revisitDue?: boolean;
  /**
   * Deals whose close date has been pushed out at least once
   * (`deals.push_count >= 1`) — the board's "show slipped deals only" toggle.
   */
  slipped?: boolean;
  /**
   * A `DEAL_FIELD_SPECS` key. Matches deals that OWE that field at their
   * current stage and have not filled it — the same predicate the Team
   * Performance heatmap counts, so clicking a cell reading "3 of 12" opens
   * exactly the 9 deals behind it.
   *
   * Owing is half the definition: a Lead is not missing a close date, it is
   * forbidden from having one. See `fieldMissingSql`.
   */
  missingField?: string;
  /**
   * Phase 1 risk band, inclusive upward: `elevated` matches elevated AND
   * high. Reads the nightly `deal_risk_scores` row — a deal never scored
   * (the job has not run, or it is won/lost/hold) matches neither.
   */
  riskBand?: 'elevated' | 'high';
  /**
   * Deals tagged with ANY of these offerings (0066). OR within the group,
   * like every other multi-id filter here — a rep looking at "SafeOps360 or
   * AnytimeHire" wants both books, not their intersection, which for
   * offerings would be the near-empty set of bundles carrying exactly both.
   *
   * Matches on ALL tags, not just the primary one: a deal that bundles a
   * product with a service belongs in either filter. That is the same
   * reading the funnel report uses, so a filtered list and a filtered funnel
   * can't show different populations.
   */
  offeringIds?: string[];
  /**
   * Deals with no offering tag at all — the legacy backlog.
   *
   * This is the ONLY backfill mechanism the feature ships: no bulk action, no
   * migration, no forced prompt. The team works the list down at its own pace
   * and this filter is how they find what is left. It is deliberately
   * MUTUALLY EXCLUSIVE in meaning with `offeringIds` (nothing can be both
   * untagged and tagged with X); when both arrive the query ANDs them and
   * correctly returns nothing, rather than silently dropping one.
   */
  uncategorized?: boolean;
};

/** Field keys the `missing=` filter accepts — the completeness spec's own. */
export const MISSING_FIELD_KEYS: readonly string[] = DEAL_FIELD_SPECS.map(
  (s) => s.key,
);

export const SCORE_BANDS = ['strong', 'moderate', 'at_risk'] as const;

const URL_FILTER_KEYS = [
  'stage',
  'stages',
  'amountMin',
  'amountMax',
  'closeFrom',
  'closeTo',
  'stale',
  'staleDays',
  'companyId',
  'companyIds',
  'mine',
  'unassigned',
  'owner',
  'approval',
  'score',
  'revisitDue',
  'slipped',
  'missing',
  'risk',
  'offering',
  'uncategorized',
] as const;

/**
 * Every URL key the filter bar owns. Used by `pushFilters` to clear
 * stale params before re-serializing the new state — without this list
 * a toggled-off filter (e.g. unchecking "My deals") would leave its
 * key sitting in the URL and the next render would re-apply it.
 */
export const DEAL_FILTER_URL_KEYS: readonly string[] = URL_FILTER_KEYS;

export function parseDealFilters(
  raw: Partial<Record<string, string | string[] | undefined>>,
): DealFilters {
  const stage = raw.stage ?? raw.stages;
  const stages = stage
    ? (Array.isArray(stage) ? stage : stage.split(','))
        .map((s) => s.trim())
        .filter((s): s is DealStage =>
          (DEAL_STAGES as readonly string[]).includes(s),
        )
    : [];

  const num = (v: string | string[] | undefined): number | undefined => {
    if (typeof v !== 'string') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const iso = (v: string | string[] | undefined): string | undefined => {
    if (typeof v !== 'string') return undefined;
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  };
  const flag = (v: string | string[] | undefined): boolean =>
    v === '1' || v === 'true';

  // Comma-list parser for multi-id filter groups. Accepts either the
  // canonical `?key=a,b,c` form or a repeated query param (`?key=a&key=b`)
  // so URLSearchParams round-trips don't lose data either way.
  const idList = (v: string | string[] | undefined): string[] => {
    if (v === undefined) return [];
    const flat = Array.isArray(v) ? v.join(',') : v;
    return flat
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  // `companyIds` is the new canonical key; `companyId` is the legacy
  // single-value alias kept so already-bookmarked URLs still parse.
  const companyIds = idList(raw.companyIds ?? raw.companyId);
  const ownerIds = idList(raw.owner);
  const offeringIds = idList(raw.offering);

  return {
    stages: stages.length > 0 ? stages : undefined,
    amountMinorMin: num(raw.amountMin),
    amountMinorMax: num(raw.amountMax),
    expectedCloseFrom: iso(raw.closeFrom),
    expectedCloseTo: iso(raw.closeTo),
    stale: flag(raw.stale),
    staleDays:
      typeof raw.staleDays === 'string'
        ? Number(raw.staleDays) || undefined
        : undefined,
    companyIds: companyIds.length > 0 ? companyIds : undefined,
    mine: flag(raw.mine),
    unassigned: flag(raw.unassigned),
    ownerIds: ownerIds.length > 0 ? ownerIds : undefined,
    awaitingApproval: raw.approval === 'pending',
    approvedOnly: raw.approval === 'approved',
    score:
      raw.score === 'strong' ||
      raw.score === 'moderate' ||
      raw.score === 'at_risk'
        ? raw.score
        : undefined,
    revisitDue: flag(raw.revisitDue),
    slipped: flag(raw.slipped),
    // Validated against the spec here rather than at the query, so an
    // unknown key from a hand-edited URL degrades to "no filter" instead of
    // reaching the SQL builder at all.
    missingField:
      typeof raw.missing === 'string' && MISSING_FIELD_KEYS.includes(raw.missing)
        ? raw.missing
        : undefined,
    riskBand:
      raw.risk === 'high' || raw.risk === 'elevated' ? raw.risk : undefined,
    offeringIds: offeringIds.length > 0 ? offeringIds : undefined,
    uncategorized: flag(raw.uncategorized),
  };
}

export function dealFiltersToSearchParams(
  filters: DealFilters,
): URLSearchParams {
  const out = new URLSearchParams();
  if (filters.stages && filters.stages.length > 0) {
    out.set('stage', filters.stages.join(','));
  }
  if (filters.amountMinorMin !== undefined) {
    out.set('amountMin', String(filters.amountMinorMin));
  }
  if (filters.amountMinorMax !== undefined) {
    out.set('amountMax', String(filters.amountMinorMax));
  }
  if (filters.expectedCloseFrom) {
    out.set('closeFrom', filters.expectedCloseFrom);
  }
  if (filters.expectedCloseTo) {
    out.set('closeTo', filters.expectedCloseTo);
  }
  if (filters.stale) {
    out.set('stale', '1');
    if (filters.staleDays && filters.staleDays !== 14) {
      out.set('staleDays', String(filters.staleDays));
    }
  }
  if (filters.companyIds && filters.companyIds.length > 0) {
    out.set('companyIds', filters.companyIds.join(','));
  }
  if (filters.mine) out.set('mine', '1');
  if (filters.unassigned) out.set('unassigned', '1');
  if (filters.ownerIds && filters.ownerIds.length > 0) {
    out.set('owner', filters.ownerIds.join(','));
  }
  if (filters.awaitingApproval) out.set('approval', 'pending');
  else if (filters.approvedOnly) out.set('approval', 'approved');
  if (filters.score) out.set('score', filters.score);
  if (filters.revisitDue) out.set('revisitDue', '1');
  if (filters.slipped) out.set('slipped', '1');
  if (filters.missingField) out.set('missing', filters.missingField);
  if (filters.riskBand) out.set('risk', filters.riskBand);
  if (filters.offeringIds && filters.offeringIds.length > 0) {
    out.set('offering', filters.offeringIds.join(','));
  }
  if (filters.uncategorized) out.set('uncategorized', '1');
  return out;
}

/** The URL key the search box owns. Nothing else may write it. */
export const DEAL_SEARCH_URL_KEY = 'q';

/**
 * Apply a search term to the params ALREADY in the URL, touching only the
 * two keys the search box owns.
 *
 * The URL is the source of truth for what the list shows, and the search box
 * is one contributor to it — not its owner. Rebuilding the query string from
 * scratch here (which is what this replaced) silently dropped every filter
 * key: an owner filter, a `missing=` drill-through, `stale`, `slipped`, the
 * stage list. A deep link from Team Performance would arrive correctly
 * filtered and then be stripped by the first debounce tick.
 *
 * `cursor` is dropped on purpose: a new search starts at the first page, and
 * a cursor from the previous result set points into rows that are no longer
 * there.
 */
export function withSearchTerm(
  current: URLSearchParams | string,
  term: string,
): URLSearchParams {
  const next = new URLSearchParams(
    typeof current === 'string' ? current : current.toString(),
  );
  const trimmed = term.trim();
  if (trimmed) next.set(DEAL_SEARCH_URL_KEY, trimmed);
  else next.delete(DEAL_SEARCH_URL_KEY);
  next.delete('cursor');
  return next;
}

export function hasActiveDealFilters(filters: DealFilters): boolean {
  return Boolean(
    (filters.stages && filters.stages.length > 0) ||
      filters.amountMinorMin !== undefined ||
      filters.amountMinorMax !== undefined ||
      filters.expectedCloseFrom ||
      filters.expectedCloseTo ||
      filters.stale ||
      (filters.companyIds && filters.companyIds.length > 0) ||
      filters.mine ||
      filters.unassigned ||
      (filters.ownerIds && filters.ownerIds.length > 0) ||
      filters.awaitingApproval ||
      filters.approvedOnly ||
      filters.score ||
      filters.revisitDue ||
      filters.slipped ||
      filters.missingField ||
      filters.riskBand ||
      (filters.offeringIds && filters.offeringIds.length > 0) ||
      filters.uncategorized,
  );
}
