import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CheckSquare,
  Clock,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';

import { formatCurrency } from '@/lib/deals/currency';
import type {
  DailyCount,
  RecentWin,
  StaleDeal,
  UpcomingFollowUp,
  WonLostTrend,
  WorkflowHealth,
} from '@/lib/dashboard/queries';
import { type DealStage, DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import {
  TASK_PRIORITY_LABELS,
} from '@/lib/tasks/filters';
import type { MyTasksSummary } from '@/lib/tasks/queries';
import { cn } from '@/lib/utils';

/**
 * Checkpoint #3 intelligence widgets. Kept in a separate file from
 * the Checkpoint #2 overview widgets to avoid one giant module — both
 * are imported and laid out in `dashboard/page.tsx`.
 *
 * Conventions:
 *   - Surfaces use `border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)]`
 *     to match the rest of the dashboard.
 *   - Section headers: `text-[13px] font-semibold text-slate-900`.
 *   - Right-anchored Links use `text-[11px] font-medium text-indigo-600 hover:text-indigo-500 →`.
 *   - Charts are inline SVG (zero external deps) sized to fit the card.
 */

/* ============================================================ */
/* Won / Lost trend                                              */
/* ============================================================ */

export function WonLostTrendCard({
  trend,
}: {
  trend: WonLostTrend;
}) {
  // Materialise contiguous day buckets so the chart sees a full series
  // even when some days had zero wins/losses.
  const series = densifyWonLost(trend);
  const wonTotal = series.reduce((s, d) => s + d.won, 0);
  const lostTotal = series.reduce((s, d) => s + d.lost, 0);
  const maxValue = Math.max(1, ...series.map((d) => Math.max(d.won, d.lost)));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold text-slate-900">
            Won vs lost — last {trend.days}d
          </h2>
        </div>
        <Link
          href="/dashboard/deals"
          className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
        >
          View deals →
        </Link>
      </header>
      <div className="mb-3 flex items-center gap-6 text-[11px]">
        <Legend
          color="bg-emerald-500"
          icon={<TrendingUp className="h-3 w-3 text-emerald-600" aria-hidden />}
          label="Won"
          value={wonTotal}
        />
        <Legend
          color="bg-rose-400"
          icon={<TrendingDown className="h-3 w-3 text-rose-500" aria-hidden />}
          label="Lost"
          value={lostTotal}
        />
      </div>
      {wonTotal + lostTotal === 0 ? (
        <EmptyHint>
          No deals have been closed in the last {trend.days} days. Once you mark
          a deal won or lost, the trend will appear here.
        </EmptyHint>
      ) : (
        <DualSeriesChart
          series={series}
          maxValue={maxValue}
          ariaLabel={`Won and lost deals per day over the last ${trend.days} days`}
        />
      )}
    </section>
  );
}

function Legend({
  color,
  icon,
  label,
  value,
}: {
  color: string;
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-600">
      <span className={cn('h-1.5 w-1.5 rounded-full', color)} aria-hidden />
      <span className="flex items-center gap-1">
        {icon}
        <span className="font-medium text-slate-700">{label}</span>
      </span>
      <span className="text-slate-400">·</span>
      <span className="font-semibold tabular-nums text-slate-900">{value}</span>
    </span>
  );
}

function densifyWonLost(
  trend: WonLostTrend,
): Array<{ date: string; won: number; lost: number }> {
  const now = new Date();
  const out: Array<{ date: string; won: number; lost: number }> = [];
  const wonMap = new Map(trend.won.map((d) => [d.day, d.n]));
  const lostMap = new Map(trend.lost.map((d) => [d.day, d.n]));
  for (let i = trend.days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push({
      date: iso,
      won: wonMap.get(iso) ?? 0,
      lost: lostMap.get(iso) ?? 0,
    });
  }
  return out;
}

function DualSeriesChart({
  series,
  maxValue,
  ariaLabel,
}: {
  series: Array<{ date: string; won: number; lost: number }>;
  maxValue: number;
  ariaLabel: string;
}) {
  // Render as paired vertical bars per day. Cleaner than line/area for
  // a small chart with sparse data.
  const width = 100;
  const height = 36;
  const cols = series.length;
  const gap = 0.6;
  const slot = width / cols;
  const barW = (slot - gap) / 2;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-16 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      {series.map((d, i) => {
        const wonH = (d.won / maxValue) * (height - 4);
        const lostH = (d.lost / maxValue) * (height - 4);
        const x = i * slot;
        return (
          <g key={d.date}>
            <rect
              x={x}
              y={height - wonH}
              width={barW}
              height={Math.max(wonH, d.won > 0 ? 0.7 : 0)}
              rx={0.4}
              className="fill-emerald-400"
            >
              <title>{`${d.date} — won ${d.won}`}</title>
            </rect>
            <rect
              x={x + barW + gap}
              y={height - lostH}
              width={barW}
              height={Math.max(lostH, d.lost > 0 ? 0.7 : 0)}
              rx={0.4}
              className="fill-rose-300"
            >
              <title>{`${d.date} — lost ${d.lost}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

/* ============================================================ */
/* Pipeline trend sparkline (daily created)                      */
/* ============================================================ */

export function PipelineTrendSparkline({
  trend,
  days,
}: {
  trend: DailyCount[];
  days: number;
}) {
  const series = densifyDaily(trend, days);
  const total = series.reduce((s, d) => s + d.n, 0);
  const max = Math.max(1, ...series.map((d) => d.n));
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <Sparkline values={series.map((d) => d.n)} max={max} />
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-[0.06em] text-slate-500">
          New deals · {days}d
        </div>
        <div className="text-base font-semibold tabular-nums text-slate-900">
          {total}
        </div>
      </div>
    </div>
  );
}

function densifyDaily(
  rows: DailyCount[],
  days: number,
): Array<{ date: string; n: number }> {
  const now = new Date();
  const map = new Map(rows.map((r) => [r.day, r.n]));
  const out: Array<{ date: string; n: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, n: map.get(iso) ?? 0 });
  }
  return out;
}

function Sparkline({ values, max }: { values: number[]; max: number }) {
  if (values.length === 0) {
    return <div className="h-8 rounded bg-slate-50" />;
  }
  const width = 100;
  const height = 24;
  const step = width / Math.max(1, values.length - 1);
  const pts = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * (height - 2) - 1;
      return `${x},${y}`;
    })
    .join(' ');
  const areaPts = `0,${height} ${pts} ${width},${height}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-8 w-full"
      preserveAspectRatio="none"
    >
      <polygon points={areaPts} className="fill-indigo-100/70" />
      <polyline
        points={pts}
        className="fill-none stroke-indigo-500"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ============================================================ */
/* Workflow health (replaces RecentWorkflowsStrip)               */
/* ============================================================ */

export function WorkflowHealthCard({
  health,
}: {
  health: WorkflowHealth;
}) {
  const errorRate =
    health.total > 0 ? Math.round((health.failed / health.total) * 100) : 0;
  const tone =
    health.failed === 0 && health.running === 0
      ? 'ok'
      : health.failed > 0
        ? 'failing'
        : 'busy';
  const lastSuccessStr = health.lastSuccessAt
    ? relTime(health.lastSuccessAt)
    : '—';
  const oldestRunningStr = health.oldestRunningAt
    ? relTime(health.oldestRunningAt)
    : null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-slate-900">
          Workflow health
        </h2>
        <Link
          href="/dashboard/workflows"
          className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
        >
          View runs →
        </Link>
      </header>

      <div className="mb-3 flex items-center gap-2">
        <StatusDot tone={tone} />
        <span className="text-[12px] font-medium text-slate-800">
          {tone === 'ok'
            ? 'All quiet'
            : tone === 'busy'
              ? 'Running'
              : 'Needs attention'}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-slate-400">
          last {health.days}d
        </span>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <Stat
          label="Completed"
          value={health.completed}
          tone="emerald"
        />
        <Stat label="Failed" value={health.failed} tone="rose" />
        <Stat label="Skipped" value={health.skipped} tone="slate" />
      </dl>

      <div className="mt-3 space-y-1 text-[11px] text-slate-500">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" aria-hidden />
          <span>Last success</span>
          <span className="ml-auto tabular-nums text-slate-700">
            {lastSuccessStr}
          </span>
        </div>
        {oldestRunningStr ? (
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-blue-500" aria-hidden />
            <span>Running since</span>
            <span className="ml-auto tabular-nums text-slate-700">
              {oldestRunningStr}
            </span>
          </div>
        ) : null}
        {errorRate > 0 ? (
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 text-amber-500" aria-hidden />
            <span>Error rate</span>
            <span className="ml-auto tabular-nums text-rose-600">
              {errorRate}%
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StatusDot({ tone }: { tone: 'ok' | 'busy' | 'failing' }) {
  const styles = {
    ok: 'bg-emerald-500',
    busy: 'bg-blue-500',
    failing: 'bg-rose-500',
  };
  return (
    <span className="relative inline-flex h-2 w-2">
      <span
        className={cn(
          'absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping',
          styles[tone],
        )}
      />
      <span
        className={cn('relative inline-flex h-2 w-2 rounded-full', styles[tone])}
      />
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'rose' | 'slate';
}) {
  const valueClass = {
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
    slate: 'text-slate-600',
  }[tone];
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
      <div className="text-[9px] font-medium uppercase tracking-[0.06em] text-slate-500">
        {label}
      </div>
      <div className={cn('mt-0.5 text-base font-semibold tabular-nums', valueClass)}>
        {value}
      </div>
    </div>
  );
}

/* ============================================================ */
/* Upcoming follow-ups                                           */
/* ============================================================ */

export function UpcomingFollowUpsCard({
  rows,
}: {
  rows: UpcomingFollowUp[];
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <CalendarClock className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">
            Follow-ups
          </h2>
        </div>
        <Link
          href="/dashboard/deals"
          className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
        >
          All deals →
        </Link>
      </header>
      {rows.length === 0 ? (
        <EmptyHint>
          No deals with close dates in the next 2 weeks. Set an expected
          close date on a deal to track follow-ups.
        </EmptyHint>
      ) : (
        <ul className="-mx-2 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/dashboard/deals/${row.id}`}
                className="flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-slate-50"
              >
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide tabular-nums',
                    row.daysUntilClose < 0
                      ? 'bg-rose-100 text-rose-700'
                      : row.daysUntilClose <= 3
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-600',
                  )}
                  title={row.expectedCloseDate}
                >
                  {row.daysUntilClose < 0
                    ? `${Math.abs(row.daysUntilClose)}d late`
                    : row.daysUntilClose === 0
                      ? 'today'
                      : `${row.daysUntilClose}d`}
                </span>
                <span className="flex-1 truncate text-[12.5px] text-slate-700">
                  {row.name}
                </span>
                <span className="hidden shrink-0 font-mono text-[10px] text-slate-400 sm:inline">
                  {formatCurrency(row.amountMinor, row.currency)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ============================================================ */
/* Stale deals                                                   */
/* ============================================================ */

export function StaleDealsCard({
  rows,
  staleDays = 14,
}: {
  rows: StaleDeal[];
  staleDays?: number;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-amber-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">
            Needs attention
          </h2>
        </div>
        <span className="text-[10px] text-slate-400">
          no update {staleDays}d+
        </span>
      </header>
      {rows.length === 0 ? (
        <EmptyHint>
          Nothing stale right now — every active deal has moved in the last{' '}
          {staleDays} days. Keep it up.
        </EmptyHint>
      ) : (
        <ul className="-mx-2 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/dashboard/deals/${row.id}`}
                className="flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-slate-50"
              >
                <StaleBadge stage={row.stage} />
                <span className="flex-1 truncate text-[12.5px] text-slate-700">
                  {row.name}
                </span>
                <span className="shrink-0 tabular-nums text-[10px] text-amber-600">
                  {row.daysSinceUpdate}d
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STAGE_BADGE_STYLES: Record<DealStage, string> = {
  lead: 'bg-slate-100 text-slate-600',
  qualified: 'bg-blue-100 text-blue-700',
  proposal: 'bg-indigo-100 text-indigo-700',
  negotiation: 'bg-amber-100 text-amber-800',
  hold: 'bg-orange-100 text-orange-700',
  won: 'bg-emerald-100 text-emerald-700',
  lost: 'bg-rose-100 text-rose-700',
};

function StaleBadge({ stage }: { stage: DealStage }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wide',
        STAGE_BADGE_STYLES[stage],
      )}
    >
      {DEAL_STAGE_LABELS[stage].slice(0, 4)}
    </span>
  );
}

/* ============================================================ */
/* Recent wins                                                   */
/* ============================================================ */

export function RecentWinsCard({ rows }: { rows: RecentWin[] }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">
            Recent wins
          </h2>
        </div>
        <Link
          href="/dashboard/deals"
          className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
        >
          View all →
        </Link>
      </header>
      {rows.length === 0 ? (
        <EmptyHint>
          No closed-won deals yet. The next celebration shows up here as soon
          as you move a deal to <span className="font-medium">won</span>.
        </EmptyHint>
      ) : (
        <ul className="-mx-2 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/dashboard/deals/${row.id}`}
                className="flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-slate-50"
              >
                <CheckCircle2
                  className="h-3.5 w-3.5 shrink-0 text-emerald-500"
                  aria-hidden
                />
                <span className="flex-1 truncate text-[12.5px] text-slate-700">
                  {row.name}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-slate-600 tabular-nums">
                  {formatCurrency(row.amountMinor, row.currency)}
                </span>
                <span className="hidden shrink-0 text-[10px] tabular-nums text-slate-400 sm:inline">
                  {relTime(row.closedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ============================================================ */
/* My tasks (operational CRM phase 1)                            */
/* ============================================================ */

const TASK_PRIORITY_TINT: Record<keyof typeof TASK_PRIORITY_LABELS, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-800',
  urgent: 'bg-rose-100 text-rose-700',
};

export function MyTasksCard({ summary }: { summary: MyTasksSummary }) {
  const empty = summary.openCount === 0 && summary.upcoming.length === 0;
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <CheckSquare className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">My tasks</h2>
        </div>
        <Link
          href="/dashboard/tasks?assignedToMe=1"
          className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
        >
          All my tasks →
        </Link>
      </header>

      <div className="mb-3 grid grid-cols-3 gap-2 text-[11px]">
        <Stat label="Open" value={summary.openCount} tone="slate" />
        <Stat label="Overdue" value={summary.overdueCount} tone={summary.overdueCount > 0 ? 'rose' : 'slate'} />
        <Stat label="Done · 7d" value={summary.completedThisWeek} tone="emerald" />
      </div>

      {empty ? (
        <EmptyHint>
          Nothing on your plate. Create a task on a deal or directly from
          /dashboard/tasks to track your next action.
        </EmptyHint>
      ) : (
        <ul className="-mx-2 divide-y divide-slate-100">
          {summary.upcoming.map((t) => (
            <li key={t.id}>
              <Link
                href={`/dashboard/tasks?assignedToMe=1`}
                className="flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-slate-50"
              >
                <span
                  className={cn(
                    'shrink-0 rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wide',
                    TASK_PRIORITY_TINT[t.priority],
                  )}
                >
                  {TASK_PRIORITY_LABELS[t.priority]}
                </span>
                <span className="flex-1 truncate text-[12.5px] text-slate-700">
                  {t.title}
                </span>
                {t.dueDate ? (
                  <span
                    className={cn(
                      'shrink-0 text-[10px] tabular-nums',
                      t.isOverdue ? 'text-rose-600' : 'text-slate-400',
                    )}
                  >
                    {t.isOverdue ? `${dayDiff(t.dueDate)}d late` : dueShort(t.dueDate)}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function dueShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tmrw';
  if (diff > 0 && diff <= 7) return `${diff}d`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dayDiff(iso: string): number {
  const d = new Date(iso + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.abs(
    Math.round((d.getTime() - today.getTime()) / 86_400_000),
  );
}

/* ============================================================ */
/* Shared helpers                                                */
/* ============================================================ */

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-[11px] leading-relaxed text-slate-500">
      {children}
    </p>
  );
}

function relTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}
