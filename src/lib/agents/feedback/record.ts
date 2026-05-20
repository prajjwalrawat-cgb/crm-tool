import 'server-only';

import { and, eq } from 'drizzle-orm';

import {
  agentRecommendationFeedback,
  aiSummaries,
  type AgentFeedbackVerdict,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Record an accept/ignore/dismiss/complete verdict on a
 * recommendation set. UPSERTed by (tenant, recommendation_id, user)
 * — latest verdict wins.
 *
 * `recommendation_id` MUST belong to the calling tenant (defensive
 * check against forged ids). The FK + RLS already enforce this at
 * the DB layer; the early check just gives a clean 4xx instead of
 * a constraint error.
 */
export async function recordAgentFeedback(input: {
  tenantId: string;
  userId: string;
  recommendationId: string;
  entityType?: string | null;
  entityId?: string | null;
  verdict: AgentFeedbackVerdict;
  reason?: string | null;
}): Promise<{ verdict: AgentFeedbackVerdict }> {
  return await tenantTransaction(async (tx) => {
    const [summary] = await tx
      .select({ id: aiSummaries.id })
      .from(aiSummaries)
      .where(
        and(
          eq(aiSummaries.id, input.recommendationId),
          eq(aiSummaries.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    if (!summary) {
      throw new Error('Recommendation not found in this tenant');
    }

    await tx
      .insert(agentRecommendationFeedback)
      .values({
        tenantId: input.tenantId,
        recommendationId: input.recommendationId,
        userId: input.userId,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        verdict: input.verdict,
        reason: input.reason ?? null,
      })
      .onConflictDoUpdate({
        target: [
          agentRecommendationFeedback.tenantId,
          agentRecommendationFeedback.recommendationId,
          agentRecommendationFeedback.userId,
        ],
        set: {
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          verdict: input.verdict,
          reason: input.reason ?? null,
          updatedAt: new Date(),
        },
      });
    return { verdict: input.verdict };
  });
}
