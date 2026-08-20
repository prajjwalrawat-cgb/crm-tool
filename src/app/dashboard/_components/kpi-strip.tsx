import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import {
  computeDelta,
  computePointsDelta,
  deltaDirection,
  describeDelta,
  formatDelta,
  type Delta,
} from '@/lib/dashboard/delta';
import type { DashboardKpis } from '@/lib/dashboard/kpis';
import type { DashboardRange } from '@/lib/dashboard/range';
import { fiscalYearLabel } from '@/lib/targets/fiscal';
import { pendingApprovalNote } from '@/lib/targets/quota-credit';
import { cn } from '@/lib/utils';

/**
 * The dashboard's headline strip — first thing on the page.
 *
 * Every tile shows one number plus a delta against the immediately
 * prior window of equal length (`DashboardRange.prior`). Two delta
 * flavours:
 *
 *   · `percent` — relative change, for money and durations.
 *   · `points`  — absolute percentage-point change, for rates. A win
 *                 rate moving 40% → 44% is "+4 pts", never "+10%".
 *
 * Both go through `lib/dashboard/delta`, which also decides when a
 * percentage is the WRONG answer: a zero prior window renders "New
 * this period" and a near-zero one renders the absolute change, so
 * no tile can produce another "+900%+". See that module for the rule.
 *
 * Direction ≠ good. Avg sales cycle shrinking is a win, so tiles carry
 * an explicit `higherIsBetter` flag that drives the colour; the arrow
 * always follows the raw direction.
 *
 * Quota attainment is omitted entirely (not zeroed) when the org has
 * no target for the fiscal year — an empty tile reads as "we missed",
 * which is a different and wrong statement.
 */

type Tile = {
  key: string;
  label: string;
  value: string;
  sub: string;
  delta: Delta;
  /**
   * Renders a raw change in this tile's own units, for the
   * `absolute` delta kind. Receives a positive magnitude — the chip
   * supplies the sign.
   */
  formatChange: (magnitude: number) => string;
  higherIsBetter: boolean;
  tint: 'indigo' | 'violet' | 'emerald' | 'amber' | 'sky' | 'slate';
  /** Full-precision figure for the title tooltip. */
  title?: string;
  /**
   * Optional caveat rendered under the tile in amber — for when a
   * number is correct but incomplete, and saying so is the difference
   * between a trusted tile and a suspected bug. Currently only the
   * quota tile uses it (revenue withheld by the approval gate).
   */
  footnote?: string;
};

/**
 * Hard ceiling on the quota attainment FIGURE itself (not its
 * delta). A typo'd target of ₹1 would otherwise render a six-digit
 * percentage; the exact value stays in the tooltip.
 */
const PCT_DISPLAY_CAP = 999;

export function KpiStrip({
  kpis,
  currency,
  range,
  fiscalYearStartMonth,
  className,
}: {
  kpis: DashboardKpis;
  currency: TenantCurrencyContext;
  range: DashboardRange;
  fiscalYearStartMonth: number;
  className?: string;
}) {
  const money = (m: number) =>
    currency.compactNumbers
      ? formatCompactTenantCurrency(m, currency)
      : formatTenantCurrency(m, currency);
  const exact = (m: number) => formatTenantCurrency(m, currency);

  const closed = kpis.wonCount.value + kpis.lostCount.value;

  const tiles: Tile[] = [
    {
      key: 'pipeline',
      label: 'Total pipeline',
      value: money(kpis.pipelineMinor.value),
      sub: `vs ${money(kpis.pipelineMinor.priorValue)} at period start`,
      delta: computeDelta(
        kpis.pipelineMinor.value,
        kpis.pipelineMinor.priorValue,
      ),
      formatChange: money,
      higherIsBetter: true,
      tint: 'indigo',
      title: `Open deal value: ${exact(kpis.pipelineMinor.value)}`,
    },
    {
      key: 'weighted',
      label: 'Weighted pipeline',
      value: money(kpis.weightedPipelineMinor.value),
      sub: 'Σ amount × stage win probability',
      delta: computeDelta(
        kpis.weightedPipelineMinor.value,
        kpis.weightedPipelineMinor.priorValue,
      ),
      formatChange: money,
      higherIsBetter: true,
      tint: 'violet',
      title: `Weighted value: ${exact(kpis.weightedPipelineMinor.value)}`,
    },
    {
      key: 'winRate',
      label: 'Win rate',
      value: `${Math.round(kpis.winRate.value * 100)}%`,
      sub:
        closed === 0
          ? 'no deals closed in period'
          : `${kpis.wonCount.value} won · ${kpis.lostCount.value} lost`,
      delta: computePointsDelta(kpis.winRate.value, kpis.winRate.priorValue),
      formatChange: (n) => `${n.toFixed(1)} pts`,
      higherIsBetter: true,
      tint: 'emerald',
      title: `${(kpis.winRate.value * 100).toFixed(1)}% of closed deals were won`,
    },
    {
      key: 'avgDeal',
      label: 'Avg deal size',
      value: kpis.wonCount.value === 0 ? '—' : money(kpis.avgWonDealMinor.value),
      sub: kpis.wonCount.value === 0 ? 'no wins in period' : 'won deals in period',
      // No wins in the window means there IS no average — not an
      // average of zero — so there is nothing to compare either.
      delta:
        kpis.wonCount.value === 0
          ? { kind: 'none' }
          : computeDelta(
              kpis.avgWonDealMinor.value,
              kpis.avgWonDealMinor.priorValue,
            ),
      formatChange: money,
      higherIsBetter: true,
      tint: 'sky',
      title:
        kpis.wonCount.value === 0
          ? undefined
          : `Average won deal: ${exact(kpis.avgWonDealMinor.value)}`,
    },
    {
      key: 'cycle',
      label: 'Avg sales cycle',
      value: kpis.avgCycleDays.value === 0 ? '—' : `${kpis.avgCycleDays.value}d`,
      sub: 'created → won',
      delta:
        kpis.avgCycleDays.value === 0
          ? { kind: 'none' }
          : computeDelta(kpis.avgCycleDays.value, kpis.avgCycleDays.priorValue),
      formatChange: (n) => `${n.toFixed(1)}d`,
      // Faster is better — a negative delta is green here.
      higherIsBetter: false,
      tint: 'amber',
    },
  ];

  if (kpis.quota) {
    const attainment = kpis.quota.achievedMinor / kpis.quota.targetMinor;
    const priorAttainment =
      kpis.quota.priorAchievedMinor / kpis.quota.targetMinor;
    const attainmentPct = Math.round(attainment * 100);
    // Won revenue the approval gate is holding back. Named out loud
    // rather than silently omitted — `achieved + pending` is the total
    // won revenue for the fiscal year, which is how a reader
    // reconciles this tile against the won figures elsewhere on the
    // page. See lib/targets/quota-credit.
    const withheld = pendingApprovalNote(
      kpis.quota.pendingApprovalMinor,
      kpis.quota.pendingApprovalCount,
      money,
    );
    tiles.push({
      key: 'quota',
      label: `Quota attainment · ${fiscalYearLabel(fiscalYearStartMonth, kpis.quota.fiscalYear)}`,
      // A tiny target (or a typo'd one) would otherwise render a
      // five-digit percentage. Cap the display, keep the real figure
      // in the tooltip.
      value:
        attainmentPct > PCT_DISPLAY_CAP
          ? `${PCT_DISPLAY_CAP}%+`
          : `${attainmentPct}%`,
      sub: `${money(kpis.quota.achievedMinor)} of ${money(kpis.quota.targetMinor)}`,
      delta: computePointsDelta(attainment, priorAttainment),
      formatChange: (n) => `${n.toFixed(1)} pts`,
      higherIsBetter: true,
      tint: 'slate',
      title: [
        `${attainmentPct.toLocaleString()}% — ${exact(kpis.quota.achievedMinor)} won revenue counting toward quota, against a ${exact(kpis.quota.targetMinor)} target.`,
        'Measured over the fiscal year to date, on close date.',
        withheld
          ? `A further ${exact(kpis.quota.pendingApprovalMinor)} is won but awaiting manager approval, so it is excluded until approved.`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      footnote: withheld ?? undefined,
    });
  }

  return (
    <section
      aria-label={`Key metrics · ${range.label}`}
      className={cn(
        'grid grid-cols-2 gap-2 sm:grid-cols-3',
        tiles.length === 6 ? 'xl:grid-cols-6' : 'lg:grid-cols-5',
        className,
      )}
    >
      {tiles.map((t) => (
        <KpiTile key={t.key} tile={t} priorLabel={range.label} />
      ))}
    </section>
  );
}

function KpiTile({ tile, priorLabel }: { tile: Tile; priorLabel: string }) {
  const tintBar = {
    indigo: 'bg-indigo-500',
    violet: 'bg-violet-500',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    sky: 'bg-sky-500',
    slate: 'bg-slate-300 dark:bg-slate-600',
  }[tile.tint];

  return (
    <div
      className="@container relative overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]"
      title={tile.title}
    >
      <span className={cn('absolute inset-y-0 left-0 w-0.5', tintBar)} aria-hidden />
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {tile.label}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        {/* Container query + clamp: long INR strings stay inside the
            card at every breakpoint without truncating. */}
        <span className="whitespace-nowrap font-mono text-[clamp(13px,8cqi,19px)] font-semibold leading-none tabular-nums tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          {tile.value}
        </span>
        <DeltaChip
          delta={tile.delta}
          formatChange={tile.formatChange}
          higherIsBetter={tile.higherIsBetter}
          priorLabel={priorLabel}
        />
      </div>
      <div className="mt-1 truncate text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
        {tile.sub}
      </div>
      {tile.footnote ? (
        <div className="mt-1 text-[10px] leading-snug text-amber-700 dark:text-amber-300">
          {tile.footnote}
        </div>
      ) : null}
    </div>
  );
}

function DeltaChip({
  delta,
  formatChange,
  higherIsBetter,
  priorLabel,
}: {
  delta: Delta;
  formatChange: (magnitude: number) => string;
  higherIsBetter: boolean;
  priorLabel: string;
}) {
  const direction = deltaDirection(delta);
  const title = describeDelta(delta, priorLabel, formatChange);

  if (delta.kind === 'none') {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-medium text-slate-400 dark:text-[#71717A]"
        title={title}
      >
        <Minus className="h-2.5 w-2.5" aria-hidden />
        n/a
      </span>
    );
  }

  // "New this period" carries no direction worth colouring good or bad
  // — a metric appearing out of nothing is a fact, not a verdict. Same
  // for flat.
  const good =
    delta.kind === 'new' || direction === null
      ? null
      : (direction === 'up') === higherIsBetter;

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold tabular-nums',
        delta.kind === 'new' && 'font-medium normal-case tracking-tight',
        good === null
          ? 'bg-slate-50 text-slate-500 dark:bg-[#181818] dark:text-[#A1A1AA]'
          : good
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
            : 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
      )}
    >
      {direction === null ? (
        <Minus className="h-2.5 w-2.5" aria-hidden />
      ) : direction === 'up' ? (
        <ArrowUp className="h-2.5 w-2.5" aria-hidden />
      ) : (
        <ArrowDown className="h-2.5 w-2.5" aria-hidden />
      )}
      {formatDelta(delta, formatChange)}
    </span>
  );
}
