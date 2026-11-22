import 'server-only';

import { and, eq } from 'drizzle-orm';

import { prospects } from '@/db/schema';
import type { DbExecutor } from '@/lib/db-context';

/**
 * Bump `last_activity_at` for a prospect inside the caller's transaction.
 * Promoted or deleted prospects are read-only: nothing is written.
 */
export async function touchProspectActivity(
  tx: DbExecutor,
  tenantId: string,
  prospectId: string,
): Promise<'ok' | 'not_found' | 'read_only'> {
  const [cur] = await tx
    .select({ promotedDealId: prospects.promotedDealId, deletedAt: prospects.deletedAt })
    .from(prospects)
    .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, prospectId)))
    .limit(1)
    .for('update');
  if (!cur) return 'not_found';
  if (cur.deletedAt || cur.promotedDealId) return 'read_only';
  const now = new Date();
  await tx
    .update(prospects)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, prospectId)));
  return 'ok';
}
