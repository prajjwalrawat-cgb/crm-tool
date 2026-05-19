import 'server-only';

import {
  pipelineByStageRunner,
  type PipelineByStageRow,
} from './queries/pipeline-by-stage';
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
  ChartHint,
  ReportCategory,
  ReportFilter,
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
  runner: ReportRunner<ReportFilter, unknown, unknown>;
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
    runner: pipelineByStageRunner as ReportRunner<ReportFilter, unknown, unknown>,
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
    runner: winLossRateRunner as ReportRunner<ReportFilter, unknown, unknown>,
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
    runner: staleDealsRunner as ReportRunner<ReportFilter, unknown, unknown>,
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
    runner: repPerformanceRunner as ReportRunner<ReportFilter, unknown, unknown>,
  },
};

export type ReportId =
  | 'pipeline-by-stage'
  | 'win-loss-rate'
  | 'stale-deals'
  | 'rep-performance';

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
  'win-loss-rate': WinLossRateRow;
  'stale-deals': StaleDealsRow;
  'rep-performance': RepPerformanceRow;
};
