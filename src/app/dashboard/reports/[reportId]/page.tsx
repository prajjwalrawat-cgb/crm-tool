import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { formatDateTime, formatNumber } from '@/lib/dates/format';
import {
  getReport,
  type ReportId,
} from '@/lib/reports/registry';
import type {
  EmailEngagementExtras,
  EmailEngagementRow,
} from '@/lib/reports/queries/email-engagement';
import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';
import type { RepPerformanceRow } from '@/lib/reports/queries/rep-performance';
import type {
  RevenueForecastExtras,
  RevenueForecastRow,
} from '@/lib/reports/queries/revenue-forecast';
import type {
  StaleDealsExtras,
  StaleDealsRow,
} from '@/lib/reports/queries/stale-deals';
import type {
  WinLossRateExtras,
  WinLossRateRow,
} from '@/lib/reports/queries/win-loss-rate';
import {
  DATE_RANGE_PRESET_LABELS,
  parseDateRangePreset,
} from '@/lib/reports/filters';
import type {
  DateRangePreset,
  OwnerScope,
  ReportFilter,
} from '@/lib/reports/types';
import { cn } from '@/lib/utils';

import { CsvDownloadButton } from '../_components/csv-download-button';
import { EmailEngagementSection } from '../_components/email-engagement-section';
import { PipelineByStageChart } from '../_components/pipeline-by-stage-chart';
import { RepPerformanceSection } from '../_components/rep-performance-section';
import { ReportFilterBar } from '../_components/report-filter-bar';
import { RevenueForecastSection } from '../_components/revenue-forecast-section';
import { StaleDealsSection } from '../_components/stale-deals-section';
import { WinLossRateChart } from '../_components/win-loss-rate-chart';

type Params = Promise<{ reportId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Detail page. Server-loads the report data, then dispatches to the
 * right chart/section component based on report id. Each report has a
 * typed branch so we never cast at the render boundary.
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
  const rangePreset: DateRangePreset =
    parseDateRangePreset(sp.range) ??
    (report.id === 'pipeline-by-stage' || report.id === 'stale-deals'
      ? 'all_time'
      : 'last_90d');

  return await withTenantSession(async ({ tenant, userId }) => {
    const owner: OwnerScope =
      ownerParam === 'mine' ? { type: 'mine' } : { type: 'all' };
    const filter: ReportFilter = { range: rangePreset, owner };

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
            currentRange={rangePreset}
            supportsOwnerScope={report.supportsOwnerScope}
            supportsMode={
              report.id === 'pipeline-by-stage' || report.id === 'win-loss-rate'
            }
            supportsDateRange={report.supportsDateRange}
          />
          {report.supportsCsv ? (
            <CsvDownloadButton reportId={report.id} owner={ownerParam} />
          ) : null}
        </section>

        <ReportBody reportId={report.id} result={result} mode={modeParam} />

        <footer className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span>
            Generated {formatDateTime(result.meta.generatedAt)} ·{' '}
            <span className="font-mono">{result.meta.queryMs}ms</span>
          </span>
          {report.supportsDateRange ? (
            <span className="font-mono text-slate-400">
              window: {DATE_RANGE_PRESET_LABELS[rangePreset]}
            </span>
          ) : null}
          <span className="font-mono text-slate-400">
            tenant: {tenant.name}
          </span>
        </footer>
      </main>
    );
  });
}

/**
 * Dispatcher — narrows on `reportId` to the typed branch. New reports
 * add a case here AND a registry entry. The compiler refuses to land
 * a new ReportId literal without a corresponding render branch via the
 * `_exhaustive: never` guard.
 */
function ReportBody({
  reportId,
  result,
  mode,
}: {
  reportId: ReportId;
  result: { rows: unknown[]; extras?: unknown };
  mode: 'count' | 'amount';
}): React.ReactNode {
  switch (reportId) {
    case 'pipeline-by-stage':
      return (
        <>
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <PipelineByStageChart
              rows={result.rows as PipelineByStageRow[]}
              mode={mode}
            />
          </section>
          <section className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <PipelineByStageTable rows={result.rows as PipelineByStageRow[]} />
          </section>
        </>
      );
    case 'win-loss-rate':
      return (
        <>
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <WinLossRateChart
              rows={result.rows as WinLossRateRow[]}
              mode={mode}
            />
          </section>
          <section className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <WinLossRateTable
              rows={result.rows as WinLossRateRow[]}
              extras={result.extras as WinLossRateExtras | undefined}
            />
          </section>
        </>
      );
    case 'stale-deals':
      return (
        <StaleDealsSection
          rows={result.rows as StaleDealsRow[]}
          extras={result.extras as StaleDealsExtras}
        />
      );
    case 'rep-performance':
      return (
        <RepPerformanceSection rows={result.rows as RepPerformanceRow[]} />
      );
    case 'email-engagement':
      return (
        <EmailEngagementSection
          rows={result.rows as EmailEngagementRow[]}
          extras={result.extras as EmailEngagementExtras}
        />
      );
    case 'revenue-forecast':
      return (
        <RevenueForecastSection
          rows={result.rows as RevenueForecastRow[]}
          extras={result.extras as RevenueForecastExtras}
        />
      );
    default: {
      const _exhaustive: never = reportId;
      void _exhaustive;
      return null;
    }
  }
}

function PipelineByStageTable({ rows }: { rows: PipelineByStageRow[] }) {
  return (
    <table className="min-w-full divide-y divide-slate-100 text-[13px]">
      <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
        <tr>
          <th scope="col" className="px-3 py-2 text-left font-medium">Stage</th>
          <th scope="col" className="px-3 py-2 text-right font-medium">Deals</th>
          <th scope="col" className="px-3 py-2 text-right font-medium">Total value</th>
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

function WinLossRateTable({
  rows,
  extras,
}: {
  rows: WinLossRateRow[];
  extras: WinLossRateExtras | undefined;
}) {
  const won = rows.find((r) => r.stage === 'won')?.count ?? 0;
  const lost = rows.find((r) => r.stage === 'lost')?.count ?? 0;
  const winPct = extras ? Math.round(extras.winRate * 100) : 0;
  return (
    <table className="min-w-full divide-y divide-slate-100 text-[13px]">
      <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
        <tr>
          <th scope="col" className="px-3 py-2 text-left font-medium">Outcome</th>
          <th scope="col" className="px-3 py-2 text-right font-medium">Deals</th>
          <th scope="col" className="px-3 py-2 text-right font-medium">Revenue</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.stage} className="transition-colors hover:bg-slate-50/70">
            <td className="px-3 py-2 font-medium capitalize">{row.stage}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {formatNumber(row.count)}
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              ${formatNumber(Math.round(row.revenueMinor / 100))}
            </td>
          </tr>
        ))}
        <tr className="bg-slate-50/60">
          <td className="px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-slate-600">
            Win rate
          </td>
          <td
            colSpan={2}
            className="px-3 py-2 text-right font-mono text-[13px] font-semibold tabular-nums text-slate-900"
          >
            {won + lost === 0 ? '—' : `${winPct}%`}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
