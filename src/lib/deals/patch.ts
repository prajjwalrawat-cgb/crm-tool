import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { deals } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { tenantTransaction } from '@/lib/db-context';
import {
  clearCloseDateReason,
  setCloseDateReason,
} from '@/lib/deals/close-date-reason';
import {
  buildDealColumnPatch,
  UnitPricingIncompleteError,
} from '@/lib/deals/patch-columns';
import type { PatchDealInput } from '@/lib/deals/schema';
import { queueDealScoreRecompute } from '@/lib/deals/scoring/queue';
import { isCloseDateRequiredError } from '@/lib/deals/stage-change-reason';
import {
  CLOSE_DATE_CLEAR_BLOCKED_MESSAGE,
  closeDateRequiredMessage,
  violatesCloseDateClear,
  violatesMissingCloseDate,
} from '@/lib/deals/stage-governance';
import {
  LEAD_CLOSE_DATE_MESSAGE,
  violatesLeadCloseDate,
} from '@/lib/deals/validation';
import {
  isOrderProofRequiredError,
  ORDER_PROOF_FALLBACK_MESSAGE,
  orderProofFailure,
  OrderProofMismatchError,
} from '@/lib/order-proofs/check';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { loadSerializedDeal } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

export type ApplyDealPatchResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * The write half of an inline deal patch, shared by `patchDealAction` and
 * server-side callers (e.g. "set deal amount from quote"). Runs the business
 * rules (derived amount, Lead close date, R1/R3 close-date governance, Won
 * deal = PO value), writes only the columns present in `d`, records the
 * owner-change activity, publishes `deal.updated`, and queues a score
 * recompute. DB triggers (audit log, date pushback, stage governance) fire on
 * the same UPDATE.
 *
 * Caller responsibilities: an active tenant context, RBAC, owner-reassignment
 * checks, and resolving linked company/contact into `linkPatch`.
 */
export async function applyDealPatch(
  tenantId: string,
  actorUserId: string,
  d: PatchDealInput,
  linkPatch: Record<string, unknown> = {},
): Promise<ApplyDealPatchResult> {
  // Amount is derived (unit price × qty) either when the workspace has
  // per-unit pricing on, OR when this deal already carries a unit price +
  // qty (kept even after the toggle is turned off). In both cases a direct
  // amount patch is rejected so it can never desync.
  const settingsUnitPricing =
    d.amount !== undefined
      ? (await getOrgSettings(tenantId)).dealUnitPricingEnabled
      : false;

  let updated: typeof deals.$inferSelect | null;
  // The deal's stage at read time, captured for the error messages below —
  // the rejections are thrown from inside the transaction, where the row is
  // in scope, but reported outside it, where it is not.
  let previousStage = '';
  try {
    updated = await tenantTransaction(async (tx) => {
      const [previous] = await tx
        .select()
        .from(deals)
        .where(
          and(
            eq(deals.id, d.id),
            eq(deals.tenantId, tenantId),
            isNull(deals.deletedAt),
          ),
        )
        .limit(1);
      if (!previous) return null;

      previousStage = previous.stage;

      if (
        d.amount !== undefined &&
        (settingsUnitPricing ||
          (previous.unitPriceMinor != null && previous.quantity != null))
      ) {
        throw new Error('AMOUNT_DERIVED');
      }

      // Business rule: setting a close date on a Lead-stage deal is rejected —
      // the deal must first advance to Qualified or higher.
      const effectiveCloseDate =
        d.expectedCloseDate !== undefined
          ? d.expectedCloseDate
          : previous.expectedCloseDate;
      if (violatesLeadCloseDate(previous.stage, effectiveCloseDate)) {
        throw new Error('LEAD_CLOSE_DATE');
      }

      // R3 — THE silent-deletion path this rule exists for. An inline cell
      // edit is exactly how a rep clears a committed date with no trace: the
      // patch action can't change the stage, so there is no rollback here to
      // excuse it. Blanking is refused outright; setting a different date is
      // a pushback (R4) and passes.
      if (
        violatesCloseDateClear({
          nextStage: previous.stage,
          previousCloseDate: previous.expectedCloseDate,
          nextCloseDate: effectiveCloseDate,
        })
      ) {
        throw new Error('CLOSE_DATE_CLEAR');
      }

      // R1 — an inline edit must not leave a deal in a date-required stage
      // with no date. Catches the case the clear-check above misses: a deal
      // that never had one (legacy row, added NOT VALID) being edited now.
      if (violatesMissingCloseDate(previous.stage, effectiveCloseDate)) {
        throw new Error('CLOSE_DATE_REQUIRED');
      }

      // Only the fields present in the input become columns — see
      // lib/deals/patch-columns.ts.
      const patch = buildDealColumnPatch(d, previous, linkPatch);
      if (Object.keys(patch).length === 0) return previous;

      // 0071 — a Won deal's value stays the value of its PO.
      if (previous.stage === 'won') {
        const nextAmount = (patch.amountMinor as number | undefined) ?? previous.amountMinor;
        const nextCurrency = (patch.currency as string | undefined) ?? previous.currency;
        if (nextAmount !== previous.amountMinor || nextCurrency !== previous.currency) {
          const poFailure = await orderProofFailure(tx, {
            id: previous.id,
            tenantId,
            amountMinor: nextAmount,
            currency: nextCurrency,
          });
          if (poFailure) throw new OrderProofMismatchError(poFailure.message);
        }
      }
      patch.updatedBy = actorUserId;

      // A rep's note about why the date moved. Handed to the pushback trigger
      // via a transaction-local GUC so it lands on the same
      // `deal_date_changes` row the trigger writes for this UPDATE. Only
      // meaningful when the date is actually part of the patch.
      const attachingReason =
        d.expectedCloseDate !== undefined && !!d.closeDateChangeReason?.trim();
      if (attachingReason) {
        await setCloseDateReason(tx, d.closeDateChangeReason);
      }

      const [row] = await tx
        .update(deals)
        .set(patch)
        .where(
          and(
            eq(deals.id, d.id),
            eq(deals.tenantId, tenantId),
            isNull(deals.deletedAt),
          ),
        )
        .returning();
      // Reset immediately after the write so nothing later in this
      // transaction (or a retry of it) inherits the note.
      if (attachingReason) await clearCloseDateReason(tx);
      if (!row) return null;

      if (
        d.ownerId !== undefined &&
        (previous.ownerId ?? null) !== (row.ownerId ?? null)
      ) {
        await recordActivity(tx, {
          tenantId,
          actorUserId,
          entityType: 'deal',
          entityId: row.id,
          action: 'owner_changed',
          metadata: {
            name: row.name,
            from: previous.ownerId ?? null,
            to: row.ownerId ?? null,
          },
        });
      }

      const serialized = await loadSerializedDeal(tx, tenantId, row.id);
      if (serialized) {
        await publishRealtimeEvent(tx, {
          type: 'deal.updated',
          tenantId,
          deal: serialized,
        });
      }
      return row;
    });
  } catch (err) {
    if (err instanceof OrderProofMismatchError) {
      return { ok: false, message: err.message };
    }
    if (isOrderProofRequiredError(err)) {
      return { ok: false, message: ORDER_PROOF_FALLBACK_MESSAGE };
    }
    if (err instanceof Error && err.message === 'AMOUNT_DERIVED') {
      return {
        ok: false,
        message: 'Amount is set by Per Unit Price × Qty on the deal.',
      };
    }
    if (err instanceof Error && err.message === 'LEAD_CLOSE_DATE') {
      return { ok: false, message: LEAD_CLOSE_DATE_MESSAGE };
    }
    if (err instanceof Error && err.message === 'CLOSE_DATE_CLEAR') {
      return { ok: false, message: CLOSE_DATE_CLEAR_BLOCKED_MESSAGE };
    }
    // DB backstop (0060) for a legacy row that predates the NOT VALID
    // constraint and so still sits dateless in a date-required stage.
    if (
      (err instanceof Error && err.message === 'CLOSE_DATE_REQUIRED') ||
      isCloseDateRequiredError(err)
    ) {
      return { ok: false, message: closeDateRequiredMessage(previousStage) };
    }
    if (err instanceof UnitPricingIncompleteError) {
      return { ok: false, message: err.message };
    }
    throw err;
  }

  if (!updated) return { ok: false, message: 'Deal not found.' };
  await queueDealScoreRecompute(tenantId, d.id, 'field_edit');
  return { ok: true };
}
