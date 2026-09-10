/**
 * Shared types for the reports layer. Kept client-safe (no
 * `server-only` import) so chart components can consume the result
 * types without dragging server code into the bundle.
 *
 * Design notes:
 *   - `ReportFilter` is the only generic shape across all reports.
 *     Each individual report extends it via TypeScript intersection
 *     when it needs more filters (e.g. rep performance adds `ownerId`).
 *     We avoid one giant union of every possible filter — that would
 *     leak per-report knowledge into shared types.
 *   - `ReportResult.meta` carries non-row metadata. The UI uses
 *     `generatedAt` to render "23s ago" freshness; `queryMs` lands in
 *     the ops dashboard for SLO tracking.
 *   - `category` and `chartHint` are pure UI hints — the registry
 *     reads them, the query layer ignores them.
 */

/** Date range expressed as ISO strings, both inclusive. Always UTC. */
export type DateRange = {
  from: string;
  to: string;
};

/** Quick named ranges. Server-side resolved into `DateRange`. */
export type DateRangePreset =
  | 'today'
  | 'last_7d'
  | 'last_30d'
  | 'last_90d'
  | 'this_quarter'
  | 'this_year'
  | 'all_time';

/** Owner scope — applied uniformly across reports that have an owner concept. */
export type OwnerScope =
  | { type: 'all' }
  | { type: 'mine' }
  | { type: 'user'; userId: string };

/** Base filter every report accepts. Concrete reports may extend it. */
export type ReportFilter = {
  range: DateRangePreset | DateRange;
  owner?: OwnerScope;
};

/**
 * The filter shape as the REGISTRY sees it, after it has erased each
 * report's concrete filter type.
 *
 * The index signature is the point. Reports extend `ReportFilter` by
 * intersection — `funnel-by-offering` adds a `scope`, and more will follow —
 * but the registry stores every runner behind one erased type so the list
 * page can iterate them. Without a declared extension point, a caller that
 * passes `{ ...filter, scope }` to a registry-typed runner is rejected by
 * excess-property checking, and the only ways out are widening
 * `ReportFilter` with per-report fields (which is exactly the "one giant
 * union" this file's header rules out) or an `as` cast at every call site.
 *
 * The concrete runner still declares its real filter type and still narrows
 * it; this type only describes the erased edge.
 */
export type AnyReportFilter = ReportFilter & Record<string, unknown>;

export type ReportResultMeta = {
  generatedAt: string;
  queryMs: number;
  /** Total row count BEFORE any UI-side top-N truncation. */
  totalCount: number;
  /** Optional headline — single number for the list-page tile. */
  headline?: { label: string; value: string };
};

export type ReportResult<R, X = undefined> = {
  rows: R[];
  /**
   * Per-report computed extras the chart layer needs but that don't
   * fit the row shape. Examples: win rate %, time-window bounds the
   * runner resolved, top-N truncation flag. `undefined` for reports
   * that don't need anything beyond rows.
   */
  extras?: X;
  meta: ReportResultMeta;
};

/** What the UI tile + detail page chart layer needs to render. */
export type ChartHint =
  | 'stacked-bar'
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'heatmap'
  | 'table-only';

/** Category drives the list-page grouping + colored badge. */
export type ReportCategory =
  | 'pipeline'
  | 'performance'
  | 'activity'
  | 'email'
  | 'forecast';

export type RowOf<T> = T extends ReportRunner<unknown, infer R, unknown> ? R : never;

/**
 * The contract every report implements. `currentUserId` is passed
 * explicitly (rather than read from a global) so unit tests can drive
 * the function without an HTTP context.
 *
 * Three type parameters:
 *   F = filter shape (defaults to the base `ReportFilter`)
 *   R = row shape   (per-report)
 *   X = extras shape (per-report metadata beyond rows; e.g., winRate)
 */
export type ReportRunner<F = ReportFilter, R = unknown, X = undefined> = (
  tenantId: string,
  filters: F,
  context: { currentUserId: string },
) => Promise<ReportResult<R, X>>;
