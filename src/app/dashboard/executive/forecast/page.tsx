import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { formatTenantCurrency } from '@/lib/currency/format';
import {
  FORECAST_CATEGORY_LABELS,
  type ForecastCategory,
} from '@/lib/deals/forecast/categories';
import { resolvePeriod, type PeriodMode } from '@/lib/deals/forecast/period';
import { getForecastRollup, type ForecastCell } from '@/lib/deals/forecast/rollup';
import { getLatestSnapshotSummary } from '@/lib/deals/forecast/snapshots';
import { resolveStageProbabilities } from '@/lib/deals/stage-probability';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { listTeammates } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { ForecastPeriodSelector } from './_components/forecast-period-selector';

export const metadata = { title: 'Forecast · Executive' };

// Columns shown in the matrix (omitted deals aren't part of the forecast).
const MATRIX_CATEGORIES: ForecastCategory[] = [
  'pipeline',
  'best_case',
  'commit',
  'closed_won',
];

const CATEGORY_STAGES: Record<ForecastCategory, string> = {
  pipeline: 'lead,qualified',
  best_case: 'proposal',
  commit: 'negotiation',
  closed_won: 'won',
  omitted: 'lost,hold',
};

function lastDayISO(endExclusiveISO: string): string {
  const d = new Date(`${endExclusiveISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; period?: string }>;
}) {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const mode: PeriodMode = sp.mode === 'month' ? 'month' : 'quarter';

    const settings = await getOrgSettings(tenant.id);
    const now = new Date();
    const period = resolvePeriod(
      mode,
      sp.period ?? null,
      now,
      settings.fiscalYearStartMonth ?? 1,
    );
    const probabilities = resolveStageProbabilities(settings.stageProbabilities);

    const [rollup, teammates, lastSnapshot] = await Promise.all([
      getForecastRollup({
        tenantId: tenant.id,
        startISO: period.startISO,
        endISO: period.endISO,
        probabilities,
      }),
      listTeammates(tenant.id, tenant.name),
      getLatestSnapshotSummary(tenant.id, period.key),
    ]);

    const nameById = new Map(teammates.map((t) => [t.id, t.displayName]));
    const ownerLabel = (id: string | null) =>
      id === null ? 'Unassigned' : nameById.get(id) ?? id.slice(0, 12);

    const money = (minor: number) => formatTenantCurrency(minor, settings);

    const closeTo = lastDayISO(period.endISO);
    const cellLink = (ownerId: string | null, category: ForecastCategory) => {
      const p = new URLSearchParams();
      p.set('stage', CATEGORY_STAGES[category]);
      p.set('closeFrom', period.startISO);
      p.set('closeTo', closeTo);
      if (ownerId === null) p.set('unassigned', '1');
      else p.set('owner', ownerId);
      return `/dashboard/deals?${p.toString()}`;
    };

    const owners = [...rollup.owners].sort(
      (a, b) => b.total.amountMinor - a.total.amountMinor,
    );

    return (
      <main className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Forecast
            </h1>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              By expected close · weighted uses stage probabilities.
            </p>
          </div>
          <ForecastPeriodSelector
            mode={period.mode}
            periodKey={period.key}
            label={period.label}
            fiscalStartMonth={settings.fiscalYearStartMonth ?? 1}
          />
        </header>

        {/* Summary numbers */}
        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryCard
            title="Commit"
            subtitle="commit + closed won"
            raw={money(rollup.commit.rawMinor)}
            weighted={money(rollup.commit.weightedMinor)}
            delta={
              lastSnapshot
                ? money(rollup.commit.rawMinor - lastSnapshot.commitMinor)
                : null
            }
            deltaPositive={
              lastSnapshot
                ? rollup.commit.rawMinor - lastSnapshot.commitMinor >= 0
                : true
            }
          />
          <SummaryCard
            title="Best case"
            subtitle="commit + closed won + best case"
            raw={money(rollup.bestCase.rawMinor)}
            weighted={money(rollup.bestCase.weightedMinor)}
            delta={
              lastSnapshot
                ? money(rollup.bestCase.rawMinor - lastSnapshot.bestCaseMinor)
                : null
            }
            deltaPositive={
              lastSnapshot
                ? rollup.bestCase.rawMinor - lastSnapshot.bestCaseMinor >= 0
                : true
            }
          />
        </div>

        {/* Matrix */}
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-[#262626]">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left dark:border-[#262626] dark:bg-[#0F0F0F]">
                <th className="px-3 py-2 font-semibold text-slate-600 dark:text-[#A1A1AA]">
                  Owner
                </th>
                {MATRIX_CATEGORIES.map((c) => (
                  <th
                    key={c}
                    className="px-3 py-2 text-right font-semibold text-slate-600 dark:text-[#A1A1AA]"
                  >
                    {FORECAST_CATEGORY_LABELS[c]}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-semibold text-slate-600 dark:text-[#A1A1AA]">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Overdue — needs re-forecast, distinct row at the top */}
              {rollup.overdue.count > 0 ? (
                <tr className="border-b border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <td className="px-3 py-2 font-medium text-amber-800 dark:text-amber-200">
                    <span className="inline-flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Overdue — needs re-forecast
                    </span>
                  </td>
                  <td
                    colSpan={MATRIX_CATEGORIES.length}
                    className="px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
                  >
                    Open deals whose close date has passed — excluded from Commit
                    &amp; Best case.
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold text-amber-800 dark:text-amber-200">
                    {money(rollup.overdue.amountMinor)}
                    <span className="ml-1 text-[10px] font-normal opacity-70">
                      ({rollup.overdue.count})
                    </span>
                  </td>
                </tr>
              ) : null}

              {owners.map((row) => (
                <tr
                  key={row.ownerId ?? 'unassigned'}
                  className="border-b border-slate-100 last:border-0 dark:border-[#1A1A1A]"
                >
                  <td className="px-3 py-2 font-medium text-slate-800 dark:text-[#E4E4E7]">
                    {ownerLabel(row.ownerId)}
                  </td>
                  {MATRIX_CATEGORIES.map((c) => (
                    <MatrixCell
                      key={c}
                      cell={row.cells[c]}
                      href={cellLink(row.ownerId, c)}
                      money={money}
                    />
                  ))}
                  <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900 dark:text-[#FAFAFA]">
                    {money(row.total.amountMinor)}
                  </td>
                </tr>
              ))}

              {/* Team total */}
              <tr className="border-t-2 border-slate-300 bg-slate-50 dark:border-[#333] dark:bg-[#0F0F0F]">
                <td className="px-3 py-2 font-semibold text-slate-900 dark:text-[#FAFAFA]">
                  Team total
                </td>
                {MATRIX_CATEGORIES.map((c) => (
                  <td
                    key={c}
                    className="px-3 py-2 text-right font-mono font-semibold text-slate-900 dark:text-[#FAFAFA]"
                  >
                    {money(rollup.categoryTotals[c].amountMinor)}
                    <span className="ml-1 text-[10px] font-normal text-slate-400">
                      ({rollup.categoryTotals[c].count})
                    </span>
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-mono font-bold text-slate-900 dark:text-[#FAFAFA]">
                  {money(rollup.teamTotal.amountMinor)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {owners.length === 0 && rollup.overdue.count === 0 ? (
          <p className="text-center text-[13px] text-slate-400">
            No deals with an expected close date in {period.label}.
          </p>
        ) : null}
      </main>
    );
  });
}

function MatrixCell({
  cell,
  href,
  money,
}: {
  cell: ForecastCell;
  href: string;
  money: (m: number) => string;
}) {
  if (cell.count === 0) {
    return <td className="px-3 py-2 text-right font-mono text-slate-300">—</td>;
  }
  return (
    <td className="px-3 py-2 text-right">
      <Link
        href={href}
        className="group inline-flex items-center gap-1 font-mono text-slate-800 hover:text-indigo-600 dark:text-[#E4E4E7]"
      >
        {money(cell.amountMinor)}
        <span className="text-[10px] font-normal text-slate-400">
          ({cell.count})
        </span>
        <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </Link>
    </td>
  );
}

function SummaryCard({
  title,
  subtitle,
  raw,
  weighted,
  delta,
  deltaPositive,
}: {
  title: string;
  subtitle: string;
  raw: string;
  weighted: string;
  delta: string | null;
  deltaPositive: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            {title}
          </div>
          <div className="text-[11px] text-slate-400">{subtitle}</div>
        </div>
        {delta ? (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              deltaPositive
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
            )}
            title="vs last week's snapshot"
          >
            {deltaPositive ? '▲' : '▼'} {delta}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="font-mono text-2xl font-bold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          {raw}
        </span>
        <span className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          {weighted} weighted
        </span>
      </div>
    </div>
  );
}
