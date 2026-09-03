import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The mandatory "why is this going backward?" reason for a stage rollback (R2).
 *
 * Same mechanism, and same reasoning, as `setCloseDateReason`: the audit row is
 * written by the `deal_governance_sync` trigger (0060), not by the app, so the
 * reason has to reach the trigger — it rides in on two transaction-local GUCs
 * alongside the tenant and actor that `app_set_ctx` already sets.
 *
 * Unlike the close-date note, this one is LOAD-BEARING: the trigger REJECTS a
 * backward transition when `app.stage_change_reason_code` is empty. That is
 * what makes "you cannot roll a deal back without saying why" true of every
 * write path — including ones written later that forget to ask.
 *
 * Transaction-local (`set_config(..., true)`), so it resets at COMMIT/ROLLBACK
 * and cannot leak to the next borrower of a pooled connection. Clear it anyway
 * whenever a transaction issues more than one deal write, so a reason attached
 * to the first can't excuse a rollback in the second.
 */
export async function setStageChangeReason(
  tx: DrizzleTx,
  reason: { code: string; note?: string | null },
): Promise<void> {
  const code = reason.code.trim().slice(0, 100);
  const note = reason.note?.trim() ? reason.note.trim().slice(0, 1000) : '';
  await tx.execute(
    sql`select set_config('app.stage_change_reason_code', ${code}, true)`,
  );
  await tx.execute(
    sql`select set_config('app.stage_change_reason_note', ${note}, true)`,
  );
}

/** Drop the pending reason. The trigger reads an empty string as "none given". */
export async function clearStageChangeReason(tx: DrizzleTx): Promise<void> {
  await tx.execute(
    sql`select set_config('app.stage_change_reason_code', '', true)`,
  );
  await tx.execute(
    sql`select set_config('app.stage_change_reason_note', '', true)`,
  );
}

/**
 * The trigger's rejection, recognised.
 *
 * The service layer validates first, so in practice a user never sees this —
 * it fires only when a write path skipped the check, which is exactly when a
 * clear error beats a raw Postgres one. Matched on the message prefix the
 * trigger raises; `postgres.js` nests the driver error under `cause`.
 */
export const ROLLBACK_REASON_REQUIRED_CODE = 'ROLLBACK_REASON_REQUIRED';

export function isRollbackReasonRequiredError(err: unknown): boolean {
  if (!err) return false;
  const direct = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { message?: string } })?.cause?.message ?? '';
  return (
    direct.includes(ROLLBACK_REASON_REQUIRED_CODE) ||
    cause.includes(ROLLBACK_REASON_REQUIRED_CODE)
  );
}

/**
 * The `chk_close_date_required` CHECK constraint (R1), recognised for the same
 * reason. Reached only by a path that skipped `violatesMissingCloseDate`, or by
 * an edit to a legacy deal that predates the constraint (it was added NOT
 * VALID, so those rows exist until touched).
 */
export function isCloseDateRequiredError(err: unknown): boolean {
  if (!err) return false;
  const direct = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { message?: string } })?.cause?.message ?? '';
  return (
    direct.includes('chk_close_date_required') ||
    cause.includes('chk_close_date_required')
  );
}
