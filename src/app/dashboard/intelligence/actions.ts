'use server';

import { withTenantSession } from '@/lib/auth-guard';
import { recordAiFeedback } from '@/lib/intelligence/feedback';
import { AI_FEEDBACK_VERDICTS, type AiFeedbackVerdict } from '@/db/schema';

/**
 * Record a thumbs-up/down/dismiss on an AI insight. Optimistically called
 * from the card; the action just persists the verdict.
 *
 * Defensive validation: verdict must be in the known set; summaryId must
 * belong to the calling tenant (enforced inside recordAiFeedback).
 */
export async function recordAiFeedbackAction(input: {
  summaryId: string;
  verdict: AiFeedbackVerdict;
  reason?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!AI_FEEDBACK_VERDICTS.includes(input.verdict)) {
    return { ok: false, message: 'Invalid verdict' };
  }
  return await withTenantSession(async ({ tenant, userId }) => {
    try {
      await recordAiFeedback({
        tenantId: tenant.id,
        userId,
        summaryId: input.summaryId,
        verdict: input.verdict,
        reason: input.reason ?? null,
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
