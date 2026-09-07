import 'server-only';

import { sql, type SQL } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';
import {
  DEAL_FIELD_SPECS,
  fieldAppliesSql,
  type CustomFieldSpec,
} from '@/lib/deals/completeness';
import { getWorkspaceStageMedians } from '@/lib/deals/scoring/service';
import { timeQuery } from '@/lib/pagination/timing';
import { requiredDealCustomFields } from '@/lib/team-analytics/queries';
import type { DealStage } from '@/db/schema';

import {
  computeDealRisk,
  FALLBACK_AVG_CYCLE_DAYS,
  MIN_WON_DEALS_FOR_CYCLE,
  type DealRiskSignals,
  type RiskResult,
} from './score';
import { signalsHash } from './hash';

/**
 * RISK SCORING SERVICE — gathers the signals, applies the rubric, writes the
 * row. Called nightly by `deal-risk-nightly`; never from a page render.
 *
 * ---------------------------------------------------------------
 * EVERY SIGNAL IS BORROWED, NONE IS REDEFINED
 * ---------------------------------------------------------------
 * The point of Phase 1 is that it needs no new measurement. Each input comes
 * from the module that already owns it:
 *
 *   pushback         -> deals.push_count / total_slip_days (trigger, 0058)
 *   silence          -> deals.updated_at, the same column the stale-deal
 *                       widget and the engagement table read
 *   completeness     -> DEAL_FIELD_SPECS, rendered into SQL here exactly as
 *                       the Team Performance heatmap renders it
 *   time in stage    -> deal_stage_history's open interval + the medians the
 *                       HEALTH score uses (`getWorkspaceStageMedians`)
 *   deal age / cycle -> deals.created_at against this workspace's own won-deal
 *                       average
 *
 * A second definition of "time in stage" or "complete" would be the same
 * failure this codebase has hit before: two surfaces quoting one word and
 * meaning different numbers.
 *
 * ---------------------------------------------------------------
 * WHICH DEALS ARE SCORED
 * ---------------------------------------------------------------
 * ---------------------------------------------------------------
 * NO DENORMALISED COLUMN ON `deals`
 * ---------------------------------------------------------------
 * The obvious optimisation — mirror the score onto `deals.risk_score` the way
 * `health_score` is mirrored — was built, tried against live data, and
 * removed. Migration 0060's `chk_close_date_required` is NOT VALID, which
 * skips the back-scan but still checks on every UPDATE, so writing any column
 * to a grandfathered dateless Proposal/Negotiation deal fails the statement.
 * Guarding the write around those rows "worked", and produced the bug that
 * actually mattered: 12 deals showed a risk score on their own page and a
 * dash in the list, because the cache silently had no value for them.
 *
 * Every surface now reads `deal_risk_scores` through a join. One source, one
 * answer, and no row that a constraint can quietly exclude. At a scale where
 * ordering a list by a joined column stops being cheap (tens of thousands of
 * open deals per tenant), reintroduce the cache — but fix the dateless deals
 * first, because the constraint will be waiting.
 *
 * Open and being worked: everything except won, lost and HOLD. Hold is
 * excluded deliberately and matches the health score's cohort — a parked deal
 * is untouched by design, and scoring it "high risk, nobody has touched it in
 * 60 days" would accuse a rep of exactly what the Hold feature asked them to
 * do. Held deals whose revisit date has arrived have their own surface (the
 * `revisitDue` filter).
 */

/** Columns the risk row carries for rendering, alongside the score. */
export type ScoredDeal = {
  dealId: string;
  name: string;
  stage: DealStage;
  ownerId: string | null;
  amountMinor: number;
  currency: string;
  signals: DealRiskSignals;
  result: RiskResult;
  hash: string;
};

type RawRow = {
  id: string;
  name: string;
  stage: DealStage;
  owner_id: string | null;
  amount_minor: string | number;
  currency: string;
  push_count: number;
  total_slip_days: number;
  days_since_touch: number;
  deal_age_days: number;
  time_in_stage_days: number;
  comp_applicable: number;
  comp_filled: number;
};

/**
 * Per-deal completeness tallies, built from the SAME spec the heatmap uses.
 * Two SUM(CASE ...) expressions rather than the aggregate's FILTER form,
 * because here the grouping is one row per deal rather than per owner.
 */
function completenessColumns(customFields: readonly CustomFieldSpec[]): {
  applicable: SQL;
  filled: SQL;
} {
  const applies: SQL[] = [];
  const filled: SQL[] = [];
  for (const spec of DEAL_FIELD_SPECS) {
    const a = sql.raw(fieldAppliesSql(spec, 'd'));
    applies.push(sql`(CASE WHEN ${a} THEN 1 ELSE 0 END)`);
    filled.push(
      sql`(CASE WHEN (${a}) AND (${sql.raw(spec.filledSql('d'))}) THEN 1 ELSE 0 END)`,
    );
  }
  for (const cf of customFields) {
    applies.push(sql`1`);
    filled.push(
      sql`(CASE WHEN NULLIF(BTRIM(COALESCE(d.custom_fields ->> (${cf.key})::text, '')), '') IS NOT NULL THEN 1 ELSE 0 END)`,
    );
  }
  return {
    applicable: sql.join(applies, sql` + `),
    filled: sql.join(filled, sql` + `),
  };
}

/**
 * The workspace's average won-deal cycle, in days.
 *
 * Falls back to a generous constant until the workspace has enough wins to
 * average — a young workspace with two fast wins would otherwise get an
 * average of a fortnight and every deal it owns would read as overdue.
 */
export async function getAverageCycleDays(
  tenantId: string,
): Promise<{ days: number; derived: boolean }> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT COUNT(*)::int AS n,
             AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400) AS avg_days
      FROM deals
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND stage = 'won'
        AND closed_at IS NOT NULL
        AND closed_at > created_at
    `),
  )) as unknown as Array<{ n: number; avg_days: string | number | null }>;

  const n = Number(rows[0]?.n ?? 0);
  const avg = Number(rows[0]?.avg_days ?? 0);
  if (n >= MIN_WON_DEALS_FOR_CYCLE && Number.isFinite(avg) && avg > 0) {
    return { days: avg, derived: true };
  }
  return { days: FALLBACK_AVG_CYCLE_DAYS, derived: false };
}

/** Gather signals and score every open deal in a tenant. Pure read. */
export async function scoreOpenDeals(tenantId: string): Promise<ScoredDeal[]> {
  const customFields = await requiredDealCustomFields(tenantId);
  const comp = completenessColumns(customFields);
  const [medians, cycle] = await Promise.all([
    tenantTransaction(async (tx) => getWorkspaceStageMedians(tx, tenantId)),
    getAverageCycleDays(tenantId),
  ]);

  const rows = (await timeQuery('dealRisk.gather', async () =>
    tenantTransaction(async (tx) =>
      tx.execute(sql`
        SELECT
          d.id,
          d.name,
          d.stage::text        AS stage,
          d.owner_id,
          d.amount_minor,
          d.currency,
          COALESCE(d.push_count, 0)      AS push_count,
          COALESCE(d.total_slip_days, 0) AS total_slip_days,
          GREATEST(0, EXTRACT(EPOCH FROM (NOW() - d.updated_at)) / 86400)::int
            AS days_since_touch,
          GREATEST(0, EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 86400)::int
            AS deal_age_days,
          -- The OPEN stage-history interval, the same source the health score
          -- reads. A deal with no open interval (pre-0045) scores 0 days in
          -- stage rather than being charged for its whole life.
          COALESCE(
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - sh.entered_at)) / 86400)::int,
            0
          ) AS time_in_stage_days,
          (${comp.applicable})::int AS comp_applicable,
          (${comp.filled})::int     AS comp_filled
        FROM deals d
        LEFT JOIN LATERAL (
          SELECT h.entered_at
          FROM deal_stage_history h
          WHERE h.deal_id = d.id AND h.exited_at IS NULL
          LIMIT 1
        ) sh ON TRUE
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.deleted_at IS NULL
          AND d.stage NOT IN ('won','lost','hold')
      `),
    ),
  )) as unknown as RawRow[];

  return rows.map((r) => {
    const signals: DealRiskSignals = {
      stage: r.stage,
      pushCount: Number(r.push_count) || 0,
      totalSlipDays: Number(r.total_slip_days) || 0,
      daysSinceLastTouch: Number(r.days_since_touch) || 0,
      completenessFilled: Number(r.comp_filled) || 0,
      completenessApplicable: Number(r.comp_applicable) || 0,
      timeInStageDays: Number(r.time_in_stage_days) || 0,
      stageMedianDays: medians[r.stage] ?? 0,
      dealAgeDays: Number(r.deal_age_days) || 0,
      avgCycleDays: cycle.days,
    };
    const result = computeDealRisk(signals);
    return {
      dealId: r.id,
      name: r.name,
      stage: r.stage,
      ownerId: r.owner_id,
      amountMinor: Number(r.amount_minor) || 0,
      currency: r.currency,
      signals,
      result,
      // The hash of the PROMPT, not of the raw signals — see ./hash.
      hash: signalsHash(signals, result),
    };
  });
}

/**
 * Write the scored deals, preserving any explanation whose hash still
 * matches.
 *
 * The `CASE WHEN ... signals_hash IS DISTINCT FROM` clauses are the cache:
 * a deal whose signals are unchanged keeps yesterday's sentence and its
 * timestamp, and a deal whose signals moved has its explanation cleared so
 * the explainer picks it up. Clearing rather than leaving a stale sentence is
 * the point — an explanation that names "pushed 3 times" on a deal now pushed
 * five times is worse than no explanation at all.
 */
export async function persistRiskScores(
  tenantId: string,
  scored: ScoredDeal[],
): Promise<number> {
  if (scored.length === 0) return 0;

  const values = sql.join(
    scored.map(
      (s) =>
        sql`(${tenantId}::uuid, ${s.dealId}::uuid, ${s.result.score}::smallint, ${s.result.band},
             ${JSON.stringify(s.result.factors)}::jsonb,
             ${JSON.stringify(serializeSignals(s.signals))}::jsonb,
             ${s.hash}, now())`,
    ),
    sql`, `,
  );

  await tenantTransaction(async (tx) =>
    tx.execute(sql`
      INSERT INTO deal_risk_scores
        (tenant_id, deal_id, score, band, factors, signals, signals_hash, computed_at)
      VALUES ${values}
      ON CONFLICT (deal_id) DO UPDATE SET
        score        = EXCLUDED.score,
        band         = EXCLUDED.band,
        factors      = EXCLUDED.factors,
        signals      = EXCLUDED.signals,
        signals_hash = EXCLUDED.signals_hash,
        computed_at  = EXCLUDED.computed_at,
        explanation =
          CASE WHEN deal_risk_scores.signals_hash IS DISTINCT FROM EXCLUDED.signals_hash
               THEN NULL ELSE deal_risk_scores.explanation END,
        explanation_model =
          CASE WHEN deal_risk_scores.signals_hash IS DISTINCT FROM EXCLUDED.signals_hash
               THEN NULL ELSE deal_risk_scores.explanation_model END,
        explained_at =
          CASE WHEN deal_risk_scores.signals_hash IS DISTINCT FROM EXCLUDED.signals_hash
               THEN NULL ELSE deal_risk_scores.explained_at END
    `),
  );
  return scored.length;
}

/**
 * Drop rows for deals that are no longer scored — closed, parked or deleted.
 *
 * Without this the At Risk view would keep listing a deal that was won last
 * month, which is the fastest way to make a manager stop trusting the list.
 */
export async function pruneClosedDealRisk(tenantId: string): Promise<number> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      DELETE FROM deal_risk_scores r
      USING deals d
      WHERE r.tenant_id = ${tenantId}::uuid
        AND d.id = r.deal_id
        AND (d.deleted_at IS NOT NULL OR d.stage IN ('won','lost','hold'))
      RETURNING r.id
    `),
  )) as unknown as Array<{ id: string }>;

  return rows.length;
}

/** JSON-safe signal snapshot for the audit column. */
function serializeSignals(s: DealRiskSignals): Record<string, number | string | null> {
  return {
    stage: s.stage,
    pushCount: s.pushCount,
    totalSlipDays: s.totalSlipDays,
    daysSinceLastTouch: s.daysSinceLastTouch,
    completenessFilled: s.completenessFilled,
    completenessApplicable: s.completenessApplicable,
    timeInStageDays: s.timeInStageDays,
    stageMedianDays: Math.round(s.stageMedianDays * 10) / 10,
    dealAgeDays: s.dealAgeDays,
    avgCycleDays: Math.round(s.avgCycleDays * 10) / 10,
  };
}
