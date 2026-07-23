import 'server-only';

import { sendWorkflowEvent } from '@/lib/inngest/send';

/**
 * Enqueue a debounced deal health-score recompute (Module 2). Fire-and-forget:
 * the emitting mutation has already committed, and the recompute function is a
 * no-op when DEAL_SCORING_ENABLED is off, so callers never need to gate on the
 * flag themselves. Call it after any change to a scoring signal — activity
 * logged, stage changed, task created/completed, stakeholder added,
 * amount/close-date edited.
 */
export async function queueDealScoreRecompute(
  tenantId: string,
  dealId: string,
  reason: string,
): Promise<void> {
  await sendWorkflowEvent('crm/deal.health_recompute', {
    tenantId,
    dealId,
    reason,
  });
}
