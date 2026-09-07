import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';

import { getTeamScorecard } from './scorecard';

/**
 * PERIOD-CLOSE SNAPSHOTS — the only reason the scorecard can say "vs last
 * month" instead of showing a number with no past.
 *
 * ---------------------------------------------------------------
 * WHY THIS IS WRITTEN DOWN RATHER THAN RECOMPUTED
 * ---------------------------------------------------------------
 * Two of the five headline metrics are STATES, not event streams. "Untouched
 * deals" reads `deals.updated_at`; "field completeness" reads which columns
 * are currently NULL. Both were overwritten in place the last time anyone
 * edited a deal, so there is no query that returns what either looked like on
 * 31 August. A comparison can only come from a value captured at the time.
 *
 * The cumulative three (revenue, pushes, deals added) could be replayed from
 * the logs, but replaying six aggregates over a fiscal year on every page load
 * is the cost this design exists to avoid — and a strip where two tiles mean
 * "vs the stored month-close" while three mean "vs a replayed instant" is
 * worse than one that means one thing.
 *
 * ---------------------------------------------------------------
 * RAW COUNTERS ONLY
 * ---------------------------------------------------------------
 * Percentages are never stored — their numerator and denominator are. A
 * stored "62% attainment" cannot be re-derived if the definition changes, and
 * it lies when the denominator moves: a rep whose target was raised in
 * September would appear to have gone backwards in October having closed
 * more. Deltas are computed from the pairs at read time, by `metricDelta`.
 *
 * ---------------------------------------------------------------
 * CAPTURE IS THE SAME CODE THE PAGE RENDERS
 * ---------------------------------------------------------------
 * `captureTeamMetrics` calls `getTeamScorecard` — the very function the page
 * calls — and writes its output. Nothing here re-derives a metric with its
 * own SQL, because a baseline computed by a second implementation is not a
 * baseline, it is a second opinion.
 */

/* ================================================================
 * The metric registry
 * ================================================================ */

/**
 * `cumulative` — accrues from the start of the fiscal year (revenue closed,
 * pushes made, deals added). It RESETS at the fiscal-year boundary, so a
 * baseline from a previous year would show a catastrophic fake drop every
 * January; these only ever compare against a baseline inside the same year.
 *
 * `state` — true as of the moment it was captured (open deals, untouched
 * deals, how full the fields are). These carry across a year boundary
 * happily: the pipeline on 1 January is the same pipeline it was on 31
 * December.
 */
export type MetricKind = 'cumulative' | 'state';

export type TeamMetric = {
  key: string;
  kind: MetricKind;
};

export const TEAM_METRICS = [
  /** Fiscal-year revenue attributed to this year (attainment numerator). */
  { key: 'fy_revenue_minor', kind: 'cumulative' },
  /** The annual target it is measured against (attainment denominator). */
  { key: 'revenue_target_minor', kind: 'cumulative' },
  { key: 'push_events', kind: 'cumulative' },
  { key: 'days_pushed', kind: 'cumulative' },
  { key: 'deals_created', kind: 'cumulative' },
  { key: 'open_deals', kind: 'state' },
  { key: 'stale_open_deals', kind: 'state' },
  /** Completeness numerator / denominator — never the percentage. */
  { key: 'completeness_filled', kind: 'state' },
  { key: 'completeness_applicable', kind: 'state' },
] as const satisfies readonly TeamMetric[];

export type TeamMetricKey = (typeof TEAM_METRICS)[number]['key'];

const METRIC_KIND = new Map<string, MetricKind>(
  TEAM_METRICS.map((m) => [m.key, m.kind]),
);

/* ================================================================
 * Period keys
 * ================================================================ */

/** 'YYYY-MM' for a moment, in UTC — the period a snapshot row is filed under. */
export function periodKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The month before `period`. '2026-01' → '2025-12'. */
export function previousPeriodKey(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/* ================================================================
 * Capture
 * ================================================================ */

type SnapshotRow = { metric: string; repId: string | null; value: number };

/**
 * Flatten a scorecard into snapshot rows — team row (repId null) plus one row
 * per rep per metric.
 *
 * Exported for the self-test, which asserts every registry metric is actually
 * produced. A metric declared and never written would surface as a permanent
 * "no comparison yet" on one tile and nowhere else.
 */
export function scorecardToRows(scorecard: {
  team: {
    revenueTargetMinor: number;
    fyRevenueMinor: number;
    pushEvents: number;
    daysPushed: number;
    dealsCreated: number;
    openDeals: number;
    staleOpenDeals: number;
    completeness: { applicable: number; filled: number };
  };
  rows: Array<{
    userId: string;
    revenueTargetMinor: number;
    fyRevenueMinor: number;
    pushback: { pushEvents: number; daysPushed: number };
    engagement: {
      dealsCreated: number;
      openDeals: number;
      staleOpenDeals: number;
    };
    completeness: { total: { applicable: number; filled: number } };
  }>;
}): SnapshotRow[] {
  const out: SnapshotRow[] = [];
  const push = (metric: TeamMetricKey, repId: string | null, value: number) =>
    out.push({ metric, repId, value: Math.round(value) });

  const t = scorecard.team;
  push('fy_revenue_minor', null, t.fyRevenueMinor);
  push('revenue_target_minor', null, t.revenueTargetMinor);
  push('push_events', null, t.pushEvents);
  push('days_pushed', null, t.daysPushed);
  push('deals_created', null, t.dealsCreated);
  push('open_deals', null, t.openDeals);
  push('stale_open_deals', null, t.staleOpenDeals);
  push('completeness_filled', null, t.completeness.filled);
  push('completeness_applicable', null, t.completeness.applicable);

  for (const r of scorecard.rows) {
    push('fy_revenue_minor', r.userId, r.fyRevenueMinor);
    push('revenue_target_minor', r.userId, r.revenueTargetMinor);
    push('push_events', r.userId, r.pushback.pushEvents);
    push('days_pushed', r.userId, r.pushback.daysPushed);
    push('deals_created', r.userId, r.engagement.dealsCreated);
    push('open_deals', r.userId, r.engagement.openDeals);
    push('stale_open_deals', r.userId, r.engagement.staleOpenDeals);
    push('completeness_filled', r.userId, r.completeness.total.filled);
    push('completeness_applicable', r.userId, r.completeness.total.applicable);
  }
  return out;
}

/**
 * Capture one tenant's scorecard under `period`.
 *
 * Idempotent: the unique index makes a re-run overwrite the period rather
 * than double it, which matters because the cron retries twice and because a
 * human running the backfill script should be able to do it again without
 * thinking about it.
 *
 * Returns the number of rows written.
 */
export async function captureTeamMetrics(
  tenantId: string,
  tenantName: string,
  fiscalYear: number,
  startMonth: number,
  now: Date,
  period: string = periodKey(now),
): Promise<number> {
  const scorecard = await getTeamScorecard(
    tenantId,
    tenantName,
    fiscalYear,
    startMonth,
    now,
  );
  const rows = scorecardToRows(scorecard);
  if (rows.length === 0) return 0;

  const values = sql.join(
    rows.map(
      (r) =>
        sql`(${tenantId}::uuid, ${r.metric}, ${r.repId}, ${period}, ${r.value}::bigint, now())`,
    ),
    sql`, `,
  );

  await tenantTransaction(async (tx) =>
    tx.execute(sql`
      INSERT INTO team_metric_snapshots
        (tenant_id, metric, rep_id, period, value, computed_at)
      VALUES ${values}
      ON CONFLICT (tenant_id, metric, COALESCE(rep_id, ''), period)
      DO UPDATE SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at
    `),
  );
  return rows.length;
}

/* ================================================================
 * Read
 * ================================================================ */

/** `metric -> repId ('' = team) -> value`, for one baseline period. */
export type SnapshotValues = Map<string, Map<string, number>>;

export type SnapshotBaseline = {
  /** The period the values came from, or null when nothing was found. */
  period: string | null;
  values: SnapshotValues;
};

export type Baselines = {
  /** Most recent period before `currentPeriod`, inside the fiscal year. */
  cumulative: SnapshotBaseline;
  /** Most recent period before `currentPeriod`, from any year. */
  state: SnapshotBaseline;
};

/**
 * The baselines a scorecard needs, in one query.
 *
 * Two of them, because the two metric kinds cannot share one: a cumulative
 * figure compared against last December resets to near-zero every January and
 * would render as a 100% collapse, while a state figure compared only inside
 * the fiscal year would lose its comparison for the whole first month of the
 * year for no reason.
 *
 * Picking the most recent AVAILABLE period rather than insisting on exactly
 * the previous month means a missed cron run degrades to "vs two months ago"
 * — labelled with the period it actually used — instead of silently
 * disappearing.
 */
export async function readBaselines(
  tenantId: string,
  currentPeriod: string,
  fiscalYearStartPeriod: string,
): Promise<Baselines> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT metric, rep_id, period, value
      FROM team_metric_snapshots
      WHERE tenant_id = ${tenantId}::uuid
        AND period < ${currentPeriod}
    `),
  )) as unknown as Array<{
    metric: string;
    rep_id: string | null;
    period: string;
    value: string | number;
  }>;

  // Latest period overall, and latest inside the fiscal year. String compare
  // is safe: 'YYYY-MM' sorts lexicographically exactly as it does
  // chronologically, which is the reason the key is shaped that way.
  let statePeriod: string | null = null;
  let cumulativePeriod: string | null = null;
  for (const r of rows) {
    if (statePeriod === null || r.period > statePeriod) statePeriod = r.period;
    if (
      r.period >= fiscalYearStartPeriod &&
      (cumulativePeriod === null || r.period > cumulativePeriod)
    ) {
      cumulativePeriod = r.period;
    }
  }

  const collect = (period: string | null): SnapshotValues => {
    const out: SnapshotValues = new Map();
    if (period === null) return out;
    for (const r of rows) {
      if (r.period !== period) continue;
      const byRep = out.get(r.metric) ?? new Map<string, number>();
      byRep.set(r.rep_id ?? '', Number(r.value) || 0);
      out.set(r.metric, byRep);
    }
    return out;
  };

  return {
    cumulative: { period: cumulativePeriod, values: collect(cumulativePeriod) },
    state: { period: statePeriod, values: collect(statePeriod) },
  };
}

/** Look up one metric for one rep ('' = team) in the right baseline. */
export function baselineValue(
  baselines: Baselines,
  metric: string,
  repId: string | null,
): { value: number; period: string } | null {
  const kind = METRIC_KIND.get(metric) ?? 'state';
  const baseline = kind === 'cumulative' ? baselines.cumulative : baselines.state;
  if (baseline.period === null) return null;
  const v = baseline.values.get(metric)?.get(repId ?? '');
  if (v === undefined) return null;
  return { value: v, period: baseline.period };
}
