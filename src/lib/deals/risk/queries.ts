import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';
import { timeQuery } from '@/lib/pagination/timing';
import type { DealStage } from '@/db/schema';

import { deterministicExplanation, type RiskBand, type RiskFactor } from './score';

/**
 * READ SIDE of the risk layer. Every one of these reads a stored row — none
 * of them scores anything. The score is written nightly; a page render must
 * never trigger a recompute, let alone an API call.
 */

export type DealRiskRow = {
  dealId: string;
  score: number;
  band: RiskBand;
  factors: RiskFactor[];
  /**
   * The sentence to render. Claude's when one exists for the current signals,
   * otherwise the deterministic join of the top factors — never null, never a
   * "generating…" placeholder that would be indistinguishable from a broken
   * pipeline a week later.
   */
  explanation: string;
  /** True when the sentence above came from the model rather than the rubric. */
  explanationFromModel: boolean;
  computedAt: string;
};

export type AtRiskDeal = DealRiskRow & {
  name: string;
  stage: DealStage;
  ownerId: string | null;
  amountMinor: number;
  currency: string;
  companyName: string | null;
};

type RawRiskRow = {
  deal_id: string;
  score: number;
  band: string;
  factors: RiskFactor[] | null;
  explanation: string | null;
  computed_at: string | Date;
};

function toRow(r: RawRiskRow): DealRiskRow {
  const factors = r.factors ?? [];
  const fromModel = Boolean(r.explanation && r.explanation.trim().length > 0);
  return {
    dealId: r.deal_id,
    score: Number(r.score) || 0,
    band: r.band as RiskBand,
    factors,
    explanation: fromModel
      ? (r.explanation as string)
      : deterministicExplanation({
          score: Number(r.score) || 0,
          band: r.band as RiskBand,
          factors,
        }),
    explanationFromModel: fromModel,
    computedAt:
      r.computed_at instanceof Date
        ? r.computed_at.toISOString()
        : String(r.computed_at),
  };
}

/** One deal's risk, for the deal detail card. Null when never scored. */
export async function getDealRisk(
  tenantId: string,
  dealId: string,
): Promise<DealRiskRow | null> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT deal_id, score, band, factors, explanation, computed_at
      FROM deal_risk_scores
      WHERE tenant_id = ${tenantId}::uuid AND deal_id = ${dealId}::uuid
      LIMIT 1
    `),
  )) as unknown as RawRiskRow[];
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * The At Risk view: highest score first.
 *
 * `minScore` defaults to the Elevated threshold — a list that included every
 * deal with a single minor factor would be the deal list with extra columns,
 * and the whole point is that it is shorter than that.
 */
export async function listAtRiskDeals(
  tenantId: string,
  opts: { minScore?: number; limit?: number; ownerId?: string | null } = {},
): Promise<AtRiskDeal[]> {
  const minScore = opts.minScore ?? 30;
  const limit = Math.min(opts.limit ?? 100, 300);
  const ownerId = opts.ownerId ?? null;

  const rows = (await timeQuery('dealRisk.atRisk', async () =>
    tenantTransaction(async (tx) =>
      tx.execute(sql`
        SELECT
          r.deal_id, r.score, r.band, r.factors, r.explanation, r.computed_at,
          d.name, d.stage::text AS stage, d.owner_id,
          d.amount_minor, d.currency,
          c.name AS company_name
        FROM deal_risk_scores r
        JOIN deals d ON d.id = r.deal_id
        LEFT JOIN companies c ON c.id = d.company_id
        WHERE r.tenant_id = ${tenantId}::uuid
          AND d.deleted_at IS NULL
          AND d.stage NOT IN ('won','lost','hold')
          AND r.score >= ${minScore}
          AND (${ownerId}::text IS NULL OR d.owner_id = ${ownerId}::text)
        ORDER BY r.score DESC, d.amount_minor DESC
        LIMIT ${limit}
      `),
    ),
  )) as unknown as Array<
    RawRiskRow & {
      name: string;
      stage: DealStage;
      owner_id: string | null;
      amount_minor: string | number;
      currency: string;
      company_name: string | null;
    }
  >;

  return rows.map((r) => ({
    ...toRow(r),
    name: r.name,
    stage: r.stage,
    ownerId: r.owner_id,
    amountMinor: Number(r.amount_minor) || 0,
    currency: r.currency,
    companyName: r.company_name,
  }));
}

/** Band counts for the At Risk header. */
export async function getRiskSummary(
  tenantId: string,
): Promise<{ high: number; elevated: number; low: number; scored: number; explained: number; lastComputedAt: string | null }> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE band = 'high')::int      AS high,
        COUNT(*) FILTER (WHERE band = 'elevated')::int  AS elevated,
        COUNT(*) FILTER (WHERE band = 'low')::int       AS low,
        COUNT(*)::int                                   AS scored,
        COUNT(*) FILTER (WHERE explanation IS NOT NULL)::int AS explained,
        MAX(computed_at)                                AS last_computed_at
      FROM deal_risk_scores
      WHERE tenant_id = ${tenantId}::uuid
    `),
  )) as unknown as Array<{
    high: number;
    elevated: number;
    low: number;
    scored: number;
    explained: number;
    last_computed_at: string | Date | null;
  }>;
  const r = rows[0];
  const last = r?.last_computed_at ?? null;
  return {
    high: Number(r?.high ?? 0),
    elevated: Number(r?.elevated ?? 0),
    low: Number(r?.low ?? 0),
    scored: Number(r?.scored ?? 0),
    explained: Number(r?.explained ?? 0),
    lastComputedAt:
      last == null ? null : last instanceof Date ? last.toISOString() : String(last),
  };
}
