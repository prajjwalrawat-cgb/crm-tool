'use server';

import { withTenantSession } from '@/lib/auth-guard';
import { rowsToCsv } from '@/lib/reports/csv';
import { getReport, type ReportId } from '@/lib/reports/registry';
import type {
  OwnerScope,
  ReportFilter,
} from '@/lib/reports/types';

/**
 * Returns the CSV body as a string. The page wraps it in a Response
 * with content-disposition for download. Streaming would be nice at
 * 100k rows but `rowsToCsv` is fast enough that holding the full
 * string in memory is fine at expected v1 volumes.
 *
 * Per-report shape is collapsed into a generic columns map. This
 * keeps the action signature uniform across reports — adding a new
 * report's CSV is just a registry change, not an action change.
 */
const REPORT_COLUMNS: Record<ReportId, { key: string; label: string }[]> = {
  'pipeline-by-stage': [
    { key: 'stage', label: 'Stage' },
    { key: 'stageLabel', label: 'Stage label' },
    { key: 'count', label: 'Deal count' },
    { key: 'totalAmountMinor', label: 'Total amount (minor units)' },
  ],
};

export async function buildReportCsvAction(input: {
  reportId: string;
  filters: { owner: 'all' | 'mine' };
}): Promise<{ ok: true; filename: string; csv: string } | { ok: false; message: string }> {
  const report = getReport(input.reportId);
  if (!report) return { ok: false, message: 'Unknown report' };
  if (!report.supportsCsv) return { ok: false, message: 'CSV not supported for this report' };

  return await withTenantSession(async ({ tenant, userId }) => {
    const owner: OwnerScope =
      input.filters.owner === 'mine'
        ? { type: 'mine' }
        : { type: 'all' };
    const filter: ReportFilter = { range: 'all_time', owner };

    const result = await report.runner(tenant.id, filter, {
      currentUserId: userId,
    });
    const cols = REPORT_COLUMNS[report.id as ReportId];
    const csv = rowsToCsv(
      result.rows as Record<string, unknown>[],
      cols as { key: keyof Record<string, unknown>; label: string }[],
    );
    const datestamp = new Date().toISOString().slice(0, 10);
    return {
      ok: true,
      filename: `${report.id}-${datestamp}.csv`,
      csv,
    };
  });
}
