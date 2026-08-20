import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import {
  computeCoverage,
  formatCoverageRatio,
  AT_RISK_COVERAGE_MULTIPLE,
  HEALTHY_COVERAGE_MULTIPLE,
} from '@/lib/dashboard/coverage';
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
 *
 * EVERY TILE STATES ITS OWN WINDOW. `scope` is a required field, not
 * an optional one, because this strip does not have a single window
 * and pretending otherwise is what made it untrustworthy:
 *
 *   · pipeline / weighted → a STOCK, as it stands today. There is no
 *     such thing as "pipeline during May"; only the delta looks back.
 *   · win rate / avg deal / avg cycle → FLOWS over the selected
 *     range, on close date.
 *   · quota attainment + coverage ratio → the FISCAL YEAR to date,
 *     which is what a quota is set against. They do not follow the
 *     range picker and never should: a 7-day view of an annual
 *     target is meaningless.
 *
 * A reader comparing "55% win rate" against a 24-won stage table is
 * not looking at a bug; they are looking at 90 days beside all time.
 * The scope line is how they find that out without asking.
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
  /**
   * The window this tile actually measures, in the user's words.
   * Required — a tile with no stated scope is the defect this field
   * exists to prevent.
   */
  scope: string;
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
  // "Last 90 days" → "last 90 days", so it reads inside a sentence.
  const rangeLower = range.label.toLowerCase();
  const fyLabel = kpis.quota
    ? fiscalYearLabel(fiscalYearStartMonth, kpis.quota.fiscalYear)
    : '';

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
      scope: 'Open deals, as of today',
      higherIsBetter: true,
      tint: 'indigo',
      title: `Open deal value right now: ${exact(kpis.pipelineMinor.value)}. A live snapshot — the delta compares it against the pipeline as it stood at the start of ${rangeLower}.`,
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
      scope: 'Open deals, as of today',
      higherIsBetter: true,
      tint: 'violet',
      title: `Weighted value right now: ${exact(kpis.weightedPipelineMinor.value)}. A live snapshot — the delta compares it against the weighted pipeline as it stood at the start of ${rangeLower}.`,
    },
    {
      key: 'winRate',
      label: 'Win rate',
      // Nothing closed → the rate is undefined, not zero. "0%" here
      // reads as "we lost everything", which is a different and much
      // worse claim than "nothing came up for decision".
      value: closed === 0 ? '—' : `${Math.round(kpis.winRate.value * 100)}%`,
      sub:
        closed === 0
          ? 'no deals closed in period'
          : `${kpis.wonCount.value} won · ${kpis.lostCount.value} lost`,
      delta:
        closed === 0
          ? { kind: 'none' }
          : computePointsDelta(kpis.winRate.value, kpis.winRate.priorValue),
      formatChange: (n) => `${n.toFixed(1)} pts`,
      scope: `Deals closed in ${rangeLower}`,
      higherIsBetter: true,
      tint: 'emerald',
      title: closed === 0
        ? `No deals closed in ${rangeLower}, so there is no win rate to report. This is not a 0% win rate.`
        : `${(kpis.winRate.value * 100).toFixed(1)}% of the ${closed} deals that CLOSED in ${rangeLower} were won. Counts only deals with a close date in the window — not every won deal the workspace has ever recorded, which is what the stage chart below shows.`,
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
      scope: `Deals won in ${rangeLower}`,
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
      scope: `Deals won in ${rangeLower}`,
      // Faster is better — a negative delta is green here.
      higherIsBetter: false,
      tint: 'amber',
      title: `Mean days from deal creation to close, across the ${kpis.wonCount.value} deals won in ${rangeLower}.`,
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
      label: `Quota attainment · ${fyLabel}`,
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
      // Deliberately NOT the range picker's window. A quota is an
      // annual commitment; showing 7 days of it would be noise.
      scope: `Fiscal year to date · ${fyLabel}`,
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

  // ------------------------------------------------------------------
  // Coverage ratio — open pipeline against the quota still to be closed.
  // Math + banding live in `lib/dashboard/coverage` so they can be
  // tested without rendering; this only decides how it looks.
  const coverage = computeCoverage({
    openPipelineMinor: kpis.pipelineMinor.value,
    targetMinor: kpis.quota?.targetMinor ?? null,
    achievedMinor: kpis.quota?.achievedMinor ?? 0,
  });

  if (coverage.state !== 'no-target') {
    const met = coverage.state === 'met';
    const tint: Tile['tint'] = met
      ? 'emerald'
      : coverage.band === 'healthy'
        ? 'emerald'
        : coverage.band === 'thin'
          ? 'amber'
          : 'slate';

    tiles.push({
      key: 'coverage',
      label: 'Coverage ratio',
      value: met ? 'Met' : formatCoverageRatio(coverage.ratio),
      sub: met
        ? 'target already closed'
        : `${money(kpis.pipelineMinor.value)} open vs ${money(coverage.gapMinor)} to go`,
      // No prior figure worth showing: the gap moves every time a deal
      // closes, so a period-over-period coverage delta would compare
      // two different denominators.
      delta: { kind: 'none' },
      formatChange: money,
      scope: `Open pipeline today vs remaining ${fyLabel} quota`,
      higherIsBetter: true,
      tint,
      footnote:
        !met && coverage.band !== 'healthy'
          ? `Under-covered — ${HEALTHY_COVERAGE_MULTIPLE}x (${money(coverage.healthyPipelineMinor)}) is the usual floor`
          : undefined,
      title: met
        ? `The ${fyLabel} revenue target is already met, so there is no gap left to cover.`
        : `${coverage.ratio.toFixed(2)}x — ${exact(kpis.pipelineMinor.value)} of open pipeline against ${exact(coverage.gapMinor)} still needed to reach the ${fyLabel} target. Roughly ${HEALTHY_COVERAGE_MULTIPLE}x or more is healthy at typical win rates; below ${AT_RISK_COVERAGE_MULTIPLE}x the remaining pipeline is unlikely to close the gap. The two figures are different kinds — pipeline is a snapshot as of today, the gap is fiscal-year-to-date.`,
    });
  }

  return (
    <section
      aria-label={`Key metrics · ${range.label}`}
      className={cn(
        'grid grid-cols-2 gap-2 sm:grid-cols-3',
        // 5 base tiles, plus quota and coverage when a target exists.
        tiles.length >= 7
          ? 'lg:grid-cols-4 xl:grid-cols-7'
          : tiles.length === 6
            ? 'xl:grid-cols-6'
            : 'lg:grid-cols-5',
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
      {/* The window this specific tile measures. Not every tile on
          this strip shares one, so each says its own out loud. */}
      <div className="mt-1.5 truncate border-t border-slate-100 pt-1 text-[9.5px] uppercase tracking-[0.06em] text-slate-400 dark:border-[#1F1F1F] dark:text-[#71717A]">
        {tile.scope}
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
