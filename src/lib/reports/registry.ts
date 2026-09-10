import 'server-only';

import {
  dealVelocityRunner,
  type DealVelocityRow,
} from './queries/deal-velocity';
import {
  emailEngagementRunner,
  type EmailEngagementRow,
} from './queries/email-engagement';
import {
  funnelByOfferingRunner,
  type FunnelByOfferingRow,
} from './queries/funnel-by-offering';
import {
  pipelineByStageRunner,
  type PipelineByStageRow,
} from './queries/pipeline-by-stage';
import {
  revenueForecastRunner,
  type RevenueForecastRow,
} from './queries/revenue-forecast';
import {
  repPerformanceRunner,
  type RepPerformanceRow,
} from './queries/rep-performance';
import {
  staleDealsRunner,
  type StaleDealsRow,
} from './queries/stale-deals';
import {
  winLossRateRunner,
  type WinLossRateRow,
} from './queries/win-loss-rate';
import type {
  AnyReportFilter,
  ChartHint,
  ReportCategory,
  ReportRunner,
} from './types';

/**
 * Central catalog of every report the app surfaces. The list page, the
 * detail page router, the sidebar deep-links, and (later) the command
 * palette all read from this single source.
 *
 * Adding a new report = write the runner + add an entry here. Nothing
 * else has to change for the report to appear in the UI.
 */

/**
 * Registration shape — `id` is NOT a field here; it's the registry
 * key. Declaring `id: ReportId` would create a circular reference.
 * `REPORTS` below stamps the id back in for ergonomic consumption.
 */
export type ReportRegistrationBase = {
  title: string;
  description: string;
  category: ReportCategory;
  chart: ChartHint;
  /** True if a "Download CSV" action should appear on the detail page. */
  supportsCsv: boolean;
  /** True if the report respects the date-range filter. Snapshots don't. */
  supportsDateRange: boolean;
  /** True if the report supports an owner scope. */
  supportsOwnerScope: boolean;
  /** The query function. Typed loosely here; narrowed at the call site. */
  runner: ReportRunner<AnyReportFilter, unknown, unknown>;
};

const REPORTS_INTERNAL: Record<string, ReportRegistrationBase> = {
  'pipeline-by-stage': {
    title: 'Pipeline by stage',
    description:
      'Total deal value and count grouped by current stage. Live snapshot — not a time-windowed aggregate.',
    category: 'pipeline',
    chart: 'stacked-bar',
    supportsCsv: true,
    supportsDateRange: false,
    supportsOwnerScope: true,
    runner: pipelineByStageRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
  'funnel-by-offering': {
    title: 'Funnel by offering',
    description:
      'Stage-by-stage count and value for a single offering, a category, or the whole book — plus the per-offering rollup and how much pipeline is still untagged.',
    category: 'pipeline',
    chart: 'stacked-bar',
    supportsCsv: true,
    // Live snapshot of current state, like Pipeline by stage — not a
    // time-window aggregate, so the range picker would be a lie.
    supportsDateRange: false,
    supportsOwnerScope: true,
    runner: funnelByOfferingRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
  'win-loss-rate': {
    title: 'Win / Loss rate',
    description:
      'Closed-deal performance over a time window. Won vs lost counts, revenue, and conversion rate.',
    category: 'performance',
    chart: 'bar',
    supportsCsv: true,
    supportsDateRange: true,
    supportsOwnerScope: true,
    runner: winLossRateRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
  'stale-deals': {
    title: 'Stale deals',
    description:
      'Active deals with no recent activity, no recent email, or no recent stage movement. The attention queue.',
    category: 'pipeline',
    chart: 'table-only',
    supportsCsv: true,
    supportsDateRange: false,
    supportsOwnerScope: true,
    runner: staleDealsRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
  'rep-performance': {
    title: 'Rep performance',
    description:
      'Per-rep leaderboard: revenue, deals closed, win rate, activity, emails, tasks completed. Defaults to last 90 days.',
    category: 'performance',
    chart: 'bar',
    supportsCsv: true,
    supportsDateRange: true,
    supportsOwnerScope: false,
    runner: repPerformanceRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
  'email-engagement': {
    title: 'Email engagement',
    description:
      'Outbound delivery health — sent / delivered / failed / retried counts across the selected window.',
    category: 'email',
    chart: 'bar',
    supportsCsv: true,
    supportsDateRange: true,
    supportsOwnerScope: false,
    runner: emailEngagementRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
  'revenue-forecast': {
    title: 'Revenue forecast',
    description:
      'Weighted projection of expected revenue by close month. Likely / best case / worst case scenarios from active deals.',
    category: 'forecast',
    chart: 'area',
    supportsCsv: true,
    supportsDateRange: true,
    supportsOwnerScope: false,
    runner: revenueForecastRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
  'deal-velocity': {
    title: 'Deal velocity',
    description:
      'How long deals spend in each stage and how long they take to close. Highlights bottlenecks and fastest-moving stages.',
    category: 'pipeline',
    chart: 'bar',
    supportsCsv: true,
    supportsDateRange: true,
    supportsOwnerScope: true,
    runner: dealVelocityRunner as ReportRunner<AnyReportFilter, unknown, unknown>,
  },
};

export type ReportId =
  | 'pipeline-by-stage'
  | 'funnel-by-offering'
  | 'win-loss-rate'
  | 'stale-deals'
  | 'rep-performance'
  | 'email-engagement'
  | 'revenue-forecast'
  | 'deal-velocity';

/** The full registration including its id — handy for list rendering. */
export type ReportRegistration = ReportRegistrationBase & { id: ReportId };

export const REPORTS: Record<ReportId, ReportRegistration> = Object.fromEntries(
  Object.entries(REPORTS_INTERNAL).map(([id, reg]) => [
    id,
    { ...reg, id: id as ReportId },
  ]),
) as Record<ReportId, ReportRegistration>;

export const REPORT_IDS = Object.keys(REPORTS) as ReportId[];

export function getReport(id: string): ReportRegistration | null {
  return id in REPORTS ? REPORTS[id as ReportId] : null;
}

/**
 * Compile-time mapping from `reportId` → row type. Lets the detail
 * page narrow `result.rows` without `as` casts when it dispatches to
 * the right chart component.
 */
export type ReportRowMap = {
  'pipeline-by-stage': PipelineByStageRow;
  'funnel-by-offering': FunnelByOfferingRow;
  'win-loss-rate': WinLossRateRow;
  'stale-deals': StaleDealsRow;
  'rep-performance': RepPerformanceRow;
  'email-engagement': EmailEngagementRow;
  'revenue-forecast': RevenueForecastRow;
  'deal-velocity': DealVelocityRow;
};
