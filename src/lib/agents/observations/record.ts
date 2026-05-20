import 'server-only';

import { db } from '@/db';
import { agentObservations } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import type { ObservationInput } from './types';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Synchronous observation ingestion. Call from inside an existing
 * server-action transaction so the observation rolls back with the
 * mutation it describes.
 *
 *   await db.transaction(async (tx) => {
 *     ...mutate CRM row...
 *     await recordObservation(tx, tenantId, userId, { observationType: ... });
 *   });
 *
 * The function is intentionally tx-scoped — there's no "fire and
 * forget outside the tx" variant. If the parent transaction rolls
 * back, the observation should roll back too, otherwise the
 * derivation jobs see ghost signals.
 *
 * Append-only: there's no update or delete helper here by design.
 * Compensating rows are how the system corrects mistakes.
 */
export async function recordObservation(
  tx: DrizzleTx,
  tenantId: string,
  actorUserId: string | null,
  input: ObservationInput,
): Promise<void> {
  await tx.insert(agentObservations).values({
    tenantId,
    actorUserId: actorUserId ?? null,
    observationType: input.observationType,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
    outcomeScore:
      input.outcomeScore !== undefined ? input.outcomeScore : null,
  });
}

/**
 * Convenience variant for places that don't already have an open
 * transaction (e.g. fire-and-forget from a non-mutating page render
 * that wants to log "recommendation surfaced"). Opens its own
 * tenant transaction. Use sparingly — prefer the tx variant inside
 * server actions.
 */
export async function recordObservationStandalone(
  tenantId: string,
  actorUserId: string | null,
  input: ObservationInput,
): Promise<void> {
  await tenantTransaction(async (tx) =>
    recordObservation(tx, tenantId, actorUserId, input),
  );
}
