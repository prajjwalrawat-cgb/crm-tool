import 'server-only';

import {
  pipelineByStageRunner,
  type PipelineByStageRow,
} from './queries/pipeline-by-stage';
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
 *
 * The `runner` field is typed as `ReportRunner<ReportFilter, unknown>`
 * so the registry stays a uniform map. Each detail page knows its
 * specific row shape via the `reportId` literal narrowing — see
 * `getReportTypedRows()` below.
 */

/**
 * Registration shape — `id` is NOT a field here; it's the registry
 * key. Declaring `id: ReportId` would create a circular reference
 * (the type depends on the const, the const depends on the type).
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
  runner: ReportRunner<ReportFilter, unknown>;
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
    runner: pipelineByStageRunner as ReportRunner<ReportFilter, unknown>,
  },
};

export type ReportId = 'pipeline-by-stage';

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
};
