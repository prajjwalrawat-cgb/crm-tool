import { sql } from 'drizzle-orm';

import type { db } from '@/db';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Activity actions that count as the owner touching the lead. A logged call
 * or meeting, a sent email, a note (logged as 'updated' with a noteId).
 * Synced emails count when outbound.
 */
const TOUCH_ACTIONS = new Set(['call_logged', 'meeting_logged', 'email_sent', 'email_synced']);

/**
 * First touch: stamp the open assignment when its owner acts on the lead.
 * Called from the activity recorder; cheap (one indexed UPDATE, only for
 * touch actions on deals).
 */
export async function markFirstTouch(
  tx: DrizzleTx,
  input: { tenantId: string; entityType: string; entityId: string; action: string; actorUserId: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  if (input.entityType !== 'deal') return;
  const isNote = input.action === 'updated' && typeof input.metadata?.noteId === 'string';
  if (!TOUCH_ACTIONS.has(input.action) && !isNote) return;
  const dealId = input.entityId;
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return;

  if (input.action === 'email_synced') {
    if (input.metadata?.direction !== 'outbound') return;
    // A synced outbound email may carry no actor; any open assignment counts.
    await tx.execute(sql`
      update lead_assignments set first_touch_at = now()
      where deal_id = ${dealId} and released_at is null and first_touch_at is null
        ${input.actorUserId ? sql`and assigned_to = ${input.actorUserId}` : sql``}`);
    return;
  }
  if (!input.actorUserId) return;
  await tx.execute(sql`
    update lead_assignments set first_touch_at = now()
    where deal_id = ${dealId} and released_at is null and first_touch_at is null
      and assigned_to = ${input.actorUserId}`);
}

