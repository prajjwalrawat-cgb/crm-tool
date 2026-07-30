import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The optional "why is this pushed back?" note for a close-date change.
 *
 * The note belongs to the `deal_date_changes` row, and that row is written by
 * the `deal_close_date_pushback_sync` trigger (0058), not by the app — so it
 * has to reach the trigger somehow. It rides in on a transaction-local GUC,
 * the same mechanism `app_set_ctx` already uses for the tenant and actor.
 *
 * Why a GUC and not a follow-up UPDATE on the log row: the note and the date
 * change land in the same statement, atomically. A follow-up write would need
 * to identify "the row the trigger just inserted", which is a race in any
 * concurrent edit and leaves a reason-less row behind if it fails.
 *
 * Transaction-local (`set_config(..., true)`), so it resets at COMMIT/ROLLBACK
 * and cannot leak to the next borrower of a pooled connection. Call
 * `clearCloseDateReason` anyway when a transaction issues more than one deal
 * write, so a note attached to the first can't bleed onto the second.
 */
export async function setCloseDateReason(
  tx: DrizzleTx,
  reason: string | null | undefined,
): Promise<void> {
  const value = reason?.trim() ? reason.trim().slice(0, 500) : '';
  await tx.execute(sql`select set_config('app.close_date_reason', ${value}, true)`);
}

/** Drop the pending note. The trigger reads an empty string as "no reason". */
export async function clearCloseDateReason(tx: DrizzleTx): Promise<void> {
  await tx.execute(sql`select set_config('app.close_date_reason', '', true)`);
}
