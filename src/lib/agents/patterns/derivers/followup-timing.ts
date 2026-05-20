import 'server-only';

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { agentPatterns } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { PATTERN_THRESHOLDS } from '../types';
import type { DerivationStats, PatternDeriver } from '../registry';

/**
 * `followup_timing` deriver.
 *
 * Question we're answering: within a tenant's pipeline, do deals that
 * receive a follow-up action (any activity) within H hours of stage
 * entry close at a better rate than the tenant baseline?
 *
 * Approach (pure SQL, no ML in v1):
 *   1. For every won/lost deal in the window, find the time gap
 *      between deal.created_at and the first observation row
 *      describing any follow-up touchpoint.
 *   2. Bucket that gap into [0..24], [24..72], [72..168] hours.
 *   3. For each bucket, compute win-rate vs the tenant's baseline
 *      win-rate in the same window.
 *   4. Wilson score confidence (one-tailed) — bounded, conservative
 *      at small sample sizes so noisy slices don't get amplified.
 *   5. UPSERT one row per bucket into agent_patterns.
 *
 * Tenant-scoped end to end. No cross-tenant aggregation.
 *
 * Uses `deals.closed_at` (canonical close time) instead of
 * observations to avoid coupling the v1 deriver to observation
 * coverage. Once `deal.won`/`deal.lost` observations have backfilled
 * coverage we can switch the input table.
 */
/**
 * Bucket boundaries (hours). Mirrored in the SQL VALUES clause below.
 * Same-day / 2-3 day / week-long; widen / split when we have enough
 * volume to warrant finer-grained correlations.
 */

export const deriveFollowupTimingPatterns: PatternDeriver = async ({
  tenantId,
  windowFromIso,
  windowToIso,
}): Promise<DerivationStats> => {
  const startedAt = Date.now();

  type Row = {
    bucket_from: number;
    bucket_to: number;
    bucket_total: number;
    bucket_wins: number;
    baseline_total: number;
    baseline_wins: number;
  };

  // Single query produces one row per bucket. The baseline row counts
  // are duplicated across buckets (cheap, lets the caller compute the
  // delta without a second round-trip).
  //
  // Sub-CTE `deal_followups` finds the first activity (any kind) per
  // deal — anchors the "hours to followup" calculation. Excluding
  // deal_created rows from the join via `entity_type='deal' AND
  // action != 'created'`. The cast guard mirrors the safe-uuid
  // pattern from the SQL hotfix earlier in the project.
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH scoped_deals AS (
        SELECT id, created_at, stage::text AS stage
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND stage IN ('won','lost')
          AND closed_at IS NOT NULL
          AND closed_at >= ${windowFromIso}::timestamptz
          AND closed_at <  ${windowToIso}::timestamptz
      ),
      deal_followups AS (
        SELECT
          d.id AS deal_id,
          d.stage,
          d.created_at,
          (
            SELECT min(al.created_at)
            FROM activity_logs al
            WHERE al.tenant_id = ${tenantId}::uuid
              AND al.entity_type = 'deal'
              AND al.action != 'created'
              AND al.entity_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND al.entity_id::uuid = d.id
          ) AS first_followup
        FROM scoped_deals d
      ),
      bucketed AS (
        SELECT
          df.deal_id,
          df.stage,
          CASE
            WHEN df.first_followup IS NULL THEN NULL
            ELSE extract(epoch FROM (df.first_followup - df.created_at)) / 3600.0
          END AS hours_to_followup
        FROM deal_followups df
      ),
      buckets AS (
        SELECT * FROM (VALUES
          (0::int,  24::int),
          (24::int, 72::int),
          (72::int, 168::int)
        ) AS b(bucket_from, bucket_to)
      ),
      bucket_stats AS (
        SELECT
          b.bucket_from,
          b.bucket_to,
          count(*) FILTER (
            WHERE bk.hours_to_followup >= b.bucket_from
              AND bk.hours_to_followup <  b.bucket_to
          )::int AS bucket_total,
          count(*) FILTER (
            WHERE bk.stage = 'won'
              AND bk.hours_to_followup >= b.bucket_from
              AND bk.hours_to_followup <  b.bucket_to
          )::int AS bucket_wins
        FROM buckets b
        CROSS JOIN bucketed bk
        GROUP BY b.bucket_from, b.bucket_to
      ),
      baseline AS (
        SELECT
          count(*)::int                                AS baseline_total,
          count(*) FILTER (WHERE stage = 'won')::int   AS baseline_wins
        FROM bucketed
      )
      SELECT
        bs.bucket_from,
        bs.bucket_to,
        bs.bucket_total,
        bs.bucket_wins,
        bl.baseline_total,
        bl.baseline_wins
      FROM bucket_stats bs CROSS JOIN baseline bl
      ORDER BY bs.bucket_from
    `),
  )) as unknown as Row[];

  let written = 0;
  let skipped = 0;
  const observed = rows.reduce((s, r) => s + Number(r.bucket_total), 0);

  for (const r of rows) {
    const bucketTotal = Number(r.bucket_total);
    const bucketWins = Number(r.bucket_wins);
    const baselineTotal = Number(r.baseline_total);
    const baselineWins = Number(r.baseline_wins);

    if (bucketTotal < PATTERN_THRESHOLDS.MIN_SAMPLE_SIZE) {
      skipped++;
      continue;
    }

    const baselineRate = baselineTotal > 0 ? baselineWins / baselineTotal : 0;
    const bucketRate = bucketTotal > 0 ? bucketWins / bucketTotal : 0;
    const scoreDelta = bucketRate - baselineRate;
    // Effect size matters in either direction; tiny deltas get
    // floored to zero so they don't pollute the boost loop.
    if (Math.abs(scoreDelta) < 0.05) {
      skipped++;
      continue;
    }

    // Wilson lower-bound at 95% — bounded, conservative under low n.
    const confidence = wilsonScore(bucketWins, bucketTotal);
    if (confidence < PATTERN_THRESHOLDS.NOISE_FLOOR) {
      skipped++;
      continue;
    }

    const bucket = { from: r.bucket_from, to: r.bucket_to };
    const patternKey = stableKey({
      kind: 'followup_timing',
      from: bucket.from,
      to: bucket.to,
    });

    await tenantTransaction(async (tx) =>
      tx
        .insert(agentPatterns)
        .values({
          tenantId,
          patternType: 'followup_timing',
          patternKey,
          confidenceScore: confidence,
          supportingSampleSize: bucketTotal,
          patternData: {
            kind: 'followup_timing',
            bucketHours: bucket,
            winRateBucket: bucketRate,
            winRateBaseline: baselineRate,
            scoreDelta,
            bucketSampleSize: bucketTotal,
          },
          learnedFromRange: { fromIso: windowFromIso, toIso: windowToIso },
        })
        .onConflictDoUpdate({
          target: [
            agentPatterns.tenantId,
            agentPatterns.patternType,
            agentPatterns.patternKey,
          ],
          set: {
            confidenceScore: confidence,
            supportingSampleSize: bucketTotal,
            patternData: {
              kind: 'followup_timing',
              bucketHours: bucket,
              winRateBucket: bucketRate,
              winRateBaseline: baselineRate,
              scoreDelta,
              bucketSampleSize: bucketTotal,
            },
            learnedFromRange: { fromIso: windowFromIso, toIso: windowToIso },
            updatedAt: new Date(),
          },
        }),
    );
    written++;
  }

  return {
    patternType: 'followup_timing',
    observed,
    patternsWritten: written,
    patternsSkipped: skipped,
    durationMs: Date.now() - startedAt,
  };
};

/**
 * Wilson score lower bound at 95% confidence. Returns 0..1. Used
 * because a 100% win-rate from 2 deals shouldn't outrank a 75%
 * win-rate from 40.
 */
function wilsonScore(successes: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96; // 95%
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  const lower = (center - margin) / denom;
  return Math.max(0, Math.min(1, lower));
}

function stableKey(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc: Record<string, unknown>, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
  return createHash('sha1').update(JSON.stringify(sorted)).digest('hex');
}
