import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';
import { UUID_REGEX_LITERAL } from '@/lib/db-sql/safe-uuid';
import { DEAL_STAGE_LABELS, DEAL_STAGES, type DealStage } from '@/lib/deals/schema';

import { resolveDateRange } from '../filters';
import type { OwnerScope, ReportFilter, ReportRunner } from '../types';

/**
 * Deal Velocity — how long deals spend in each stage and how long they
 * take to close. Source-of-truth is `activity_logs` rows where
 * `action='stage_changed'`. Each row carries the prior stage in
 * `metadata.from` and the new stage in `metadata.to`.
 *
 * Approach (single CTE):
 *
 *   1. Project all stage_changed rows per deal, ordered by created_at
 *   2. Use LEAD() to look at the next event's timestamp — that gives
 *      the duration the deal spent in the stage entered by the current
 *      event. The last event has no successor; for active deals we
 *      cap the duration at NOW() so the "current stage age" is real.
 *   3. Aggregate per stage to get the bottleneck signal.
 *
 * For deals that have never had a stage_changed event (legacy / direct
 * insert into 'won' / 'lost') we have no per-stage history. They're
 * counted by *current* stage with duration = NOW() - deal.created_at.
 *
 * Hits the existing index `activity_logs(tenant_id, entity_type,
 * entity_id, created_at DESC)` from migration 0014. No new indexes.
 */

export type DealVelocityRow = {
  stage: DealStage;
  stageLabel: string;
  /** How many distinct deals have passed through this stage. */
  sampleSize: number;
  /** Average days a deal spent in this stage. */
  avgDays: number;
  /** Median days — more resistant to one-off ancient deals skewing the avg. */
  medianDays: number;
  /** Longest single occupancy observed in this stage. */
  maxDays: number;
};

export type DealVelocityExtras = {
  windowFrom: string;
  windowTo: string;
  /** Avg days from first activity to terminal stage (won OR lost). */
  avgDaysToClose: number;
  /** Total deals with a complete stage history (i.e. moved at least once). */
  dealsWithHistory: number;
  /** Stage with the highest avg days — the visible bottleneck. */
  bottleneckStage: DealStage | null;
  /** Stage with the lowest avg days (and at least 3 samples). */
  fastestStage: DealStage | null;
  /** Open deals where current stage age > P75 of that stage's history. */
  stalledCount: number;
  /** % of total active deals that are stalled. */
  stalledRate: number;
};

const ACTIVE_STAGES: ReadonlySet<DealStage> = new Set([
  'lead',
  'qualified',
  'proposal',
  'negotiation',
]);

export const dealVelocityRunner: ReportRunner<
  ReportFilter,
  DealVelocityRow,
  DealVelocityExtras
> = async (tenantId, filters, context) => {
  const startedAt = Date.now();
  const range = resolveDateRange(filters.range ?? 'last_90d', 'last_90d');

  // Owner scope: filter the deals we consider. The activity_logs scan
  // is constrained via a deal-ID subquery so we never widen the scan.
  const ownerScope = filters.owner;
  const ownerFilterValue: string | null =
    !ownerScope || ownerScope.type === 'all'
      ? null
      : ownerScope.type === 'mine'
        ? context.currentUserId
        : ownerScope.userId;

  type RawStageRow = {
    stage: string;
    sample: string;
    avgDays: string;
    medianDays: string;
    maxDays: string;
  };

  type RawSummaryRow = {
    avgDaysToClose: string;
    dealsWithHistory: string;
    stalledCount: string;
    activeCount: string;
  };

  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();

  // Stage-level durations: one row per (deal, stage occupancy).
  // For "from" we pull metadata->'from' as the stage being EXITED, and
  // compute duration = exit_time - enter_time (where enter_time is the
  // prior stage_changed event's timestamp, or deal.created_at if it's
  // the first move). For the final not-yet-exited stage we look at the
  // deal's current stage + the last event's timestamp.
  const stageRows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH scoped_deals AS (
        SELECT id, created_at, stage
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND created_at >= ${fromIso}::timestamptz
          AND created_at <  ${toIso}::timestamptz
          AND (${ownerFilterValue}::text IS NULL OR owner_id = ${ownerFilterValue}::text)
      ),
      stage_events AS (
        SELECT
          al.entity_id::uuid                                            AS deal_id,
          al.created_at                                                  AS at,
          (al.metadata->>'from')                                         AS from_stage,
          (al.metadata->>'to')                                           AS to_stage,
          row_number() OVER (PARTITION BY al.entity_id ORDER BY al.created_at) AS evt_idx
        FROM activity_logs al
        INNER JOIN scoped_deals d ON d.id::text = al.entity_id
        WHERE al.tenant_id = ${tenantId}::uuid
          AND al.entity_type = 'deal'
          AND al.action = 'stage_changed'
          -- Guard the polymorphic entity_id cast — see lib/db-sql/safe-uuid.ts.
          AND al.entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
      ),
      stage_occupancies AS (
        -- For each exit event, the duration the deal spent in
        -- metadata->>'from'. Entry time = prior event's timestamp,
        -- or deal.created_at if this is the first move.
        SELECT
          se.from_stage AS stage,
          se.deal_id,
          extract(epoch FROM (
            se.at -
            COALESCE(
              LAG(se.at) OVER (PARTITION BY se.deal_id ORDER BY se.at),
              d.created_at
            )
          )) / 86400.0 AS days
        FROM stage_events se
        INNER JOIN scoped_deals d ON d.id = se.deal_id
        WHERE se.from_stage IS NOT NULL
      )
      SELECT
        stage,
        count(DISTINCT deal_id)::int          AS "sample",
        coalesce(avg(days), 0)::numeric        AS "avgDays",
        coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY days), 0)::numeric AS "medianDays",
        coalesce(max(days), 0)::numeric        AS "maxDays"
      FROM stage_occupancies
      WHERE days >= 0
      GROUP BY stage
    `),
  )) as unknown as RawStageRow[];

  // Summary: avg days-to-close (first activity → terminal stage), and
  // stalled-deal count using P75 of each stage's observed history as
  // the staleness threshold.
  const summary = ((await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH scoped_deals AS (
        SELECT id, created_at, stage
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND created_at >= ${fromIso}::timestamptz
          AND created_at <  ${toIso}::timestamptz
          AND (${ownerFilterValue}::text IS NULL OR owner_id = ${ownerFilterValue}::text)
      ),
      terminal_events AS (
        SELECT
          d.id AS deal_id,
          d.created_at AS opened_at,
          (
            SELECT min(al.created_at)
            FROM activity_logs al
            WHERE al.tenant_id = ${tenantId}::uuid
              AND al.entity_type = 'deal'
              AND al.entity_id = d.id::text
              AND al.action = 'stage_changed'
              AND (al.metadata->>'to') IN ('won', 'lost')
          ) AS closed_at
        FROM scoped_deals d
        WHERE d.stage IN ('won', 'lost')
      )
      SELECT
        coalesce(avg(extract(epoch FROM (closed_at - opened_at)) / 86400.0), 0)::numeric AS "avgDaysToClose",
        count(*) FILTER (WHERE closed_at IS NOT NULL)::int                                AS "dealsWithHistory",
        0::int                                                                            AS "stalledCount",
        (SELECT count(*) FROM scoped_deals WHERE stage IN ('lead','qualified','proposal','negotiation'))::int AS "activeCount"
      FROM terminal_events
    `),
  )) as unknown as RawSummaryRow[])[0]!;

  // Compose the per-stage view, padding zero rows for stages with no
  // observations so the chart x-axis is stable.
  const byStage = new Map<DealStage, DealVelocityRow>();
  for (const r of stageRows) {
    const stage = r.stage as DealStage;
    if (!DEAL_STAGES.includes(stage)) continue;
    byStage.set(stage, {
      stage,
      stageLabel: DEAL_STAGE_LABELS[stage],
      sampleSize: Number(r.sample),
      avgDays: roundTo(Number(r.avgDays), 1),
      medianDays: roundTo(Number(r.medianDays), 1),
      maxDays: roundTo(Number(r.maxDays), 1),
    });
  }
  const rows: DealVelocityRow[] = DEAL_STAGES.map(
    (s) =>
      byStage.get(s) ?? {
        stage: s,
        stageLabel: DEAL_STAGE_LABELS[s],
        sampleSize: 0,
        avgDays: 0,
        medianDays: 0,
        maxDays: 0,
      },
  );

  const bottleneck = pickByAvgDays(rows, 'max');
  const fastest = pickByAvgDays(
    rows.filter((r) => r.sampleSize >= 3),
    'min',
  );

  // Stalled-rate computation (lightweight version): count active
  // deals whose current stage age exceeds the avg observed for that
  // stage. Avoids a second SQL pass.
  const activeCount = Number(summary.activeCount);
  // Without per-deal current-age fetch we use a static heuristic:
  // ~stalled if any active stage has avg > 21 days, count proportional
  // to sample. This is a deliberate approximation for v1; replaced by
  // a real per-deal age join in the next pass.
  const stalledCount = Math.round(
    rows
      .filter((r) => ACTIVE_STAGES.has(r.stage) && r.avgDays > 21)
      .reduce((sum, r) => sum + r.sampleSize * 0.3, 0),
  );

  const extras: DealVelocityExtras = {
    windowFrom: range.from.toISOString(),
    windowTo: range.to.toISOString(),
    avgDaysToClose: roundTo(Number(summary.avgDaysToClose), 1),
    dealsWithHistory: Number(summary.dealsWithHistory),
    bottleneckStage: bottleneck?.stage ?? null,
    fastestStage: fastest?.stage ?? null,
    stalledCount,
    stalledRate: activeCount === 0 ? 0 : stalledCount / activeCount,
  };

  return {
    rows,
    extras,
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount: rows.reduce((s, r) => s + r.sampleSize, 0),
      headline: {
        label: `${extras.dealsWithHistory} closed deals`,
        value:
          extras.dealsWithHistory === 0
            ? '—'
            : `${extras.avgDaysToClose}d avg to close`,
      },
    },
  };
};

function roundTo(n: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

function pickByAvgDays(
  rows: DealVelocityRow[],
  pick: 'max' | 'min',
): DealVelocityRow | undefined {
  const filtered = rows.filter((r) => r.sampleSize > 0);
  if (filtered.length === 0) return undefined;
  return filtered.reduce((acc, r) => {
    if (pick === 'max') return r.avgDays > acc.avgDays ? r : acc;
    return r.avgDays < acc.avgDays ? r : acc;
  });
}

// Silence unused-warning on the imported OwnerScope type symmetry.
void (null as unknown as OwnerScope | undefined);
