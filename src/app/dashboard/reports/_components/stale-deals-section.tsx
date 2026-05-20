'use client';

import { AlertTriangle, Mail, Workflow, Zap } from 'lucide-react';
import Link from 'next/link';

import {
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import { formatDateShort, formatNumber } from '@/lib/dates/format';
import { DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import type {
  StaleDealsExtras,
  StaleDealsRow,
  StaleSeverity,
} from '@/lib/reports/queries/stale-deals';
import { cn } from '@/lib/utils';

const SEVERITY_TINT: Record<StaleSeverity, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  watch: 'bg-amber-50 text-amber-800 ring-amber-200',
  stale: 'bg-orange-50 text-orange-800 ring-orange-200',
  critical: 'bg-rose-50 text-rose-700 ring-rose-200',
};

const SEVERITY_LABEL: Record<StaleSeverity, string> = {
  ok: 'OK',
  watch: 'Watch',
  stale: 'Stale',
  critical: 'Critical',
};

/**
 * Renders both the severity histogram (4 small tiles) and the
 * attention-queue table. Combined into one component so the layout
 * stays cohesive — severity counts at top, drillable table below.
 */
export function StaleDealsSection({
  rows,
  extras,
  currency,
}: {
  rows: StaleDealsRow[];
  extras: StaleDealsExtras;
  currency: TenantCurrencyContext;
}) {
  const buckets: StaleSeverity[] = ['critical', 'stale', 'watch', 'ok'];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {buckets.map((b) => (
          <div
            key={b}
            className={cn(
              'rounded-md border p-3 ring-1',
              SEVERITY_TINT[b],
            )}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide">
              {SEVERITY_LABEL[b]}
            </div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {formatNumber(extras.severityCounts[b])}
            </div>
            <p className="mt-1 text-[10.5px] opacity-80">
              {b === 'critical'
                ? 'All 3 signals fired'
                : b === 'stale'
                  ? '2 signals fired'
                  : b === 'watch'
                    ? '1 signal fired'
                    : 'No signals'}
            </p>
          </div>
        ))}
      </div>

      <p className="text-[11.5px] text-slate-500">
        Thresholds: <span className="font-mono">activity &gt; {extras.thresholdsUsed.activityDays}d</span>{' '}
        · <span className="font-mono">email &gt; {extras.thresholdsUsed.emailDays}d</span>{' '}
        · <span className="font-mono">stage move &gt; {extras.thresholdsUsed.stageDays}d</span>
      </p>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
          <AlertTriangle
            className="mx-auto h-6 w-6 text-slate-400"
            aria-hidden
          />
          <p className="mt-2 text-[13px] font-medium text-slate-700">
            No active deals
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            Once deals enter the pipeline, this report tracks their freshness.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-100 text-[13px]">
            <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Severity
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Deal
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Stage
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Amount
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-center font-medium md:table-cell"
                >
                  Signals
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-right font-medium lg:table-cell"
                >
                  Last activity
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <StaleDealRow key={row.dealId} row={row} currency={currency} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StaleDealRow({
  row,
  currency,
}: {
  row: StaleDealsRow;
  currency: TenantCurrencyContext;
}) {
  return (
    <tr className="transition-colors hover:bg-slate-50/70">
      <td className="px-3 py-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ring-1',
            SEVERITY_TINT[row.severity],
          )}
        >
          {SEVERITY_LABEL[row.severity]}
        </span>
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/dashboard/deals/${row.dealId}`}
          className="font-medium text-slate-800 hover:text-indigo-700 hover:underline"
        >
          {row.name}
        </Link>
      </td>
      <td className="px-3 py-2 text-slate-700">
        {DEAL_STAGE_LABELS[row.stage as DealStage] ?? row.stage}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
        {formatTenantCurrency(row.amountMinor, currency)}
      </td>
      <td className="hidden px-3 py-2 md:table-cell">
        <SignalBadges row={row} />
      </td>
      <td className="hidden whitespace-nowrap px-3 py-2 text-right font-mono text-[11px] text-slate-500 lg:table-cell">
        {row.lastActivityAt ? (
          <>
            {formatDateShort(row.lastActivityAt)}
            <span className="ml-1 text-slate-400">
              ({row.daysSinceActivity}d)
            </span>
          </>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

function SignalBadges({ row }: { row: StaleDealsRow }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <SignalDot
        active={row.triggers.activityStale}
        Icon={Zap}
        title={`Activity: ${row.daysSinceActivity ?? '∞'}d ago`}
      />
      <SignalDot
        active={row.triggers.emailStale}
        Icon={Mail}
        title={`Email: ${row.daysSinceEmail ?? '∞'}d ago`}
      />
      <SignalDot
        active={row.triggers.stageStale}
        Icon={Workflow}
        title={`Stage move: ${row.daysSinceStageChange ?? '∞'}d ago`}
      />
    </div>
  );
}

function SignalDot({
  active,
  Icon,
  title,
}: {
  active: boolean;
  Icon: typeof Zap;
  title: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded-full ring-1',
        active
          ? 'bg-rose-50 text-rose-600 ring-rose-200'
          : 'bg-slate-50 text-slate-400 ring-slate-200',
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
    </span>
  );
}
