import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';

import {
  explainRisk,
  MAX_EXPLANATIONS_PER_RUN,
  riskExplainerAvailable,
} from './explain';
import { riskPromptPayload } from './hash';
import {
  persistRiskScores,
  pruneClosedDealRisk,
  scoreOpenDeals,
} from './service';
import { computeDealRisk, type DealRiskSignals } from './score';

/**
 * ONE TENANT'S NIGHTLY RISK PASS, in three steps that fail independently.
 *
 * 1. SCORE every open deal and write it. Pure arithmetic over data we already
 *    have; no network, no model.
 * 2. PRUNE rows for deals that closed, were parked or were deleted since the
 *    last run, so the At Risk list can never show a deal that was won.
 * 3. EXPLAIN the riskiest deals whose signals changed — and only those. This
 *    is the only step that costs money, and it is the only step allowed to
 *    fail without failing the run.
 *
 * Step 3 is skipped entirely when no `ANTHROPIC_API_KEY` is configured. The
 * scores are still written, the UI still renders a sentence (the rubric's
 * own), and the workspace loses nothing but the phrasing.
 */

export type RiskRunResult = {
  scored: number;
  pruned: number;
  explained: number;
  /** Deals that needed an explanation but were past this run's budget. */
  deferred: number;
  explainerAvailable: boolean;
};

export async function recomputeTenantRisk(
  tenantId: string,
  opts: { explain?: boolean; maxExplanations?: number } = {},
): Promise<RiskRunResult> {
  const scored = await scoreOpenDeals(tenantId);
  await persistRiskScores(tenantId, scored);
  const pruned = await pruneClosedDealRisk(tenantId);

  const wantExplanations = opts.explain !== false && riskExplainerAvailable();
  if (!wantExplanations) {
    return {
      scored: scored.length,
      pruned,
      explained: 0,
      deferred: 0,
      explainerAvailable: riskExplainerAvailable(),
    };
  }

  const budget = opts.maxExplanations ?? MAX_EXPLANATIONS_PER_RUN;

  // Rows whose explanation was cleared by the upsert (signals moved) or never
  // written. Ordered by score so a budget-limited first run explains the
  // deals a manager would open first.
  const pending = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT deal_id, score, band, factors, signals
      FROM deal_risk_scores
      WHERE tenant_id = ${tenantId}::uuid
        AND explanation IS NULL
        AND score > 0
      ORDER BY score DESC
      LIMIT ${budget + 1}
    `),
  )) as unknown as Array<{
    deal_id: string;
    score: number;
    band: string;
    factors: unknown;
    signals: Record<string, number | string | null>;
  }>;

  const deferred = Math.max(0, pending.length - budget);
  let explained = 0;

  for (const row of pending.slice(0, budget)) {
    // Rebuild the payload from the stored signals rather than trusting the
    // in-memory scored list: the row is what the hash was computed over, and
    // a payload derived from anything else could be cached under a key that
    // does not describe it.
    const signals = restoreSignals(row.signals);
    if (!signals) continue;
    const result = computeDealRisk(signals);
    const payload = riskPromptPayload(signals, result);

    const generated = await explainRisk({
      tenantId,
      dealId: row.deal_id,
      payload,
    });
    if (!generated) continue;

    await tenantTransaction(async (tx) =>
      tx.execute(sql`
        UPDATE deal_risk_scores
        SET explanation = ${generated.text},
            explanation_model = ${generated.model},
            explained_at = now()
        WHERE tenant_id = ${tenantId}::uuid AND deal_id = ${row.deal_id}::uuid
      `),
    );
    explained += 1;
  }

  return {
    scored: scored.length,
    pruned,
    explained,
    deferred,
    explainerAvailable: true,
  };
}

/** Rehydrate the signal snapshot written by `serializeSignals`. */
function restoreSignals(
  raw: Record<string, number | string | null> | null,
): DealRiskSignals | null {
  if (!raw || typeof raw.stage !== 'string') return null;
  const num = (k: string): number => {
    const v = raw[k];
    return typeof v === 'number' ? v : Number(v ?? 0) || 0;
  };
  return {
    stage: raw.stage as DealRiskSignals['stage'],
    pushCount: num('pushCount'),
    totalSlipDays: num('totalSlipDays'),
    daysSinceLastTouch: raw.daysSinceLastTouch == null ? null : num('daysSinceLastTouch'),
    completenessFilled: num('completenessFilled'),
    completenessApplicable: num('completenessApplicable'),
    timeInStageDays: num('timeInStageDays'),
    stageMedianDays: num('stageMedianDays'),
    dealAgeDays: num('dealAgeDays'),
    avgCycleDays: num('avgCycleDays'),
  };
}
