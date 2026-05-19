import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { formatDateTime, formatNumber } from '@/lib/dates/format';
import { getReport, type ReportId } from '@/lib/reports/registry';
import type {
  OwnerScope,
  ReportFilter,
} from '@/lib/reports/types';
import { cn } from '@/lib/utils';

import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';

import { CsvDownloadButton } from '../_components/csv-download-button';
import { PipelineByStageChart } from '../_components/pipeline-by-stage-chart';
import { ReportFilterBar } from '../_components/report-filter-bar';

type Params = Promise<{ reportId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Report detail page. Server-renders the chart data + table rows. The
 * chart itself is a client component (Recharts), as is the filter bar
 * (URL-syncing).
 *
 * Filter parsing happens here so the server has a single source of
 * truth. The chart + filter bar receive resolved values, not raw
 * URL params.
 */
export async function generateMetadata({ params }: { params: Params }) {
  const { reportId } = await params;
  const report = getReport(reportId);
  return { title: report ? report.title : 'Report' };
}

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { reportId } = await params;
  const report = getReport(reportId);
  if (!report) notFound();

  const sp = await searchParams;
  const ownerParam =
    typeof sp.owner === 'string' && (sp.owner === 'mine' || sp.owner === 'all')
      ? sp.owner
      : 'all';
  const modeParam =
    typeof sp.mode === 'string' && (sp.mode === 'amount' || sp.mode === 'count')
      ? sp.mode
      : 'amount';

  return await withTenantSession(async ({ tenant, userId }) => {
    const owner: OwnerScope =
      ownerParam === 'mine' ? { type: 'mine' } : { type: 'all' };
    const filter: ReportFilter = { range: 'all_time', owner };

    const result = await report.runner(tenant.id, filter, {
      currentUserId: userId,
    });

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/reports"
          className="inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All reports
        </Link>

        <header className="mt-3 mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {report.title}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] text-slate-500">
              {report.description}
            </p>
          </div>
          {result.meta.headline ? (
            <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {result.meta.headline.label}
              </div>
              <div className="font-mono text-lg font-semibold tabular-nums text-slate-900">
                {result.meta.headline.value}
              </div>
            </div>
          ) : null}
        </header>

        <section className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <ReportFilterBar
            reportId={report.id}
            currentOwner={ownerParam}
            currentMode={modeParam}
            supportsOwnerScope={report.supportsOwnerScope}
            supportsMode={report.id === 'pipeline-by-stage'}
          />
          {report.supportsCsv ? (
            <CsvDownloadButton reportId={report.id} owner={ownerParam} />
          ) : null}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          {renderChart(report.id, result.rows, modeParam)}
        </section>

        <section className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          {renderTable(report.id, result.rows)}
        </section>

        <footer className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span>
            Generated {formatDateTime(result.meta.generatedAt)} ·{' '}
            <span className="font-mono">{result.meta.queryMs}ms</span> · refreshes on
            page navigation
          </span>
          <span className="font-mono text-slate-400">
            tenant: {tenant.name}
          </span>
        </footer>
      </main>
    );
  });
}

function renderChart(
  reportId: ReportId,
  rows: unknown[],
  mode: 'count' | 'amount',
): React.ReactNode {
  switch (reportId) {
    case 'pipeline-by-stage':
      return (
        <PipelineByStageChart
          rows={rows as PipelineByStageRow[]}
          mode={mode}
        />
      );
    default:
      return null;
  }
}

function renderTable(reportId: ReportId, rows: unknown[]): React.ReactNode {
  switch (reportId) {
    case 'pipeline-by-stage':
      return <PipelineByStageTable rows={rows as PipelineByStageRow[]} />;
    default:
      return null;
  }
}

function PipelineByStageTable({ rows }: { rows: PipelineByStageRow[] }) {
  return (
    <table className="min-w-full divide-y divide-slate-100 text-[13px]">
      <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
        <tr>
          <th scope="col" className="px-3 py-2 text-left font-medium">
            Stage
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Deals
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Total value
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr
            key={row.stage}
            className={cn(
              'transition-colors hover:bg-slate-50/70',
              row.count === 0 && 'text-slate-400',
            )}
          >
            <td className="px-3 py-2 font-medium">{row.stageLabel}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {formatNumber(row.count)}
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              ${formatNumber(Math.round(row.totalAmountMinor / 100))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
