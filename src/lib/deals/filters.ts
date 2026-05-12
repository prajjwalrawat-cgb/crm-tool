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
 *   companyId=<uuid>           — restrict to one company
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
  companyId?: string;
  /** `mine` and `unassigned` are resolved server-side using the current user. */
  mine?: boolean;
  unassigned?: boolean;
};

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
    companyId:
      typeof raw.companyId === 'string' && raw.companyId.length > 0
        ? raw.companyId
        : undefined,
    mine: flag(raw.mine),
    unassigned: flag(raw.unassigned),
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
  if (filters.companyId) {
    out.set('companyId', filters.companyId);
  }
  if (filters.mine) out.set('mine', '1');
  if (filters.unassigned) out.set('unassigned', '1');
  return out;
}

export function hasActiveDealFilters(filters: DealFilters): boolean {
  return Boolean(
    (filters.stages && filters.stages.length > 0) ||
      filters.amountMinorMin !== undefined ||
      filters.amountMinorMax !== undefined ||
      filters.expectedCloseFrom ||
      filters.expectedCloseTo ||
      filters.stale ||
      filters.companyId ||
      filters.mine ||
      filters.unassigned,
  );
}
