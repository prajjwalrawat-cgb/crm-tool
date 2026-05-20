'use server';

import { withTenantSession } from '@/lib/auth-guard';
import { recordAgentFeedback } from '@/lib/agents/feedback/record';
import {
  AGENT_FEEDBACK_VERDICTS,
  type AgentFeedbackVerdict,
} from '@/db/schema';
import { recordObservationStandalone } from '@/lib/agents/observations/record';

/**
 * Record a verdict on a recommendation set + observation in one
 * call. The observation feeds the learning loop; the verdict drives
 * future weighting.
 */
export async function recordRecommendationVerdictAction(input: {
  recommendationId: string;
  verdict: AgentFeedbackVerdict;
  entityType?: string;
  entityId?: string;
  reason?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!AGENT_FEEDBACK_VERDICTS.includes(input.verdict)) {
    return { ok: false, message: 'Invalid verdict' };
  }
  return await withTenantSession(async ({ tenant, userId }) => {
    try {
      await recordAgentFeedback({
        tenantId: tenant.id,
        userId,
        recommendationId: input.recommendationId,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        verdict: input.verdict,
        reason: input.reason ?? null,
      });
      await recordObservationStandalone(tenant.id, userId, {
        observationType:
          input.verdict === 'accepted'
            ? 'recommendation.accepted'
            : input.verdict === 'completed'
              ? 'recommendation.completed'
              : 'recommendation.dismissed',
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: { recommendationId: input.recommendationId },
      });
      return { ok: true } as const;
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Feedback failed',
      } as const;
    }
  });
}
