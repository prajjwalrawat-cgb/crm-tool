import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { deals } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { recordObservation } from '@/lib/agents/observations/record';
import type { db } from '@/db';
import { deriveForecastCategory } from '@/lib/deals/forecast/categories';
import { loadSerializedDeal } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';
import { checkGateAndLogWarnings } from '@/lib/stage-gates/enforce';

/**
 * TEMPORARY (Lead close-date rollout). Send one Qualified deal back to Lead,
 * clearing its expected close date.
 *
 * Introducing `violatesLeadCloseDate` pushed every dated Lead deal into
 * Qualified; this is the undo for the ones that were misclassified. The rule
 * itself still stands — a Lead can't carry a close date — so the date is
 * dropped rather than carried along. The team re-enters it when the deal
 * re-qualifies.
 *
 * Qualified is the only accepted source stage, because that's the only place
 * the migration put deals. Delete this module once the backlog is cleared.
 */
export type RevertOutcome =
  /** Moved to Lead. */
  | 'moved'
  /** Not in Qualified any more, not visible to this actor, or already gone. */
  | 'skipped'
  /** A stage gate refused the transition; carries the deal name to report. */
  | { blocked: string };

/** Same shape `tenantTransaction` hands its callback. */
type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function revertDealToLead(
  tx: DrizzleTx,
  params: {
    tenantId: string;
    actorUserId: string;
    dealId: string;
    /** Set for sales personas: only their own (or unowned) deals may move. */
    restrictToOwnerUserId?: string | null;
  },
): Promise<RevertOutcome> {
  const [previous] = await tx
    .select({
      id: deals.id,
      name: deals.name,
      stage: deals.stage,
      ownerId: deals.ownerId,
      forecastCategoryOverridden: deals.forecastCategoryOverridden,
    })
    .from(deals)
    .where(
      and(
        eq(deals.id, params.dealId),
        eq(deals.tenantId, params.tenantId),
        isNull(deals.deletedAt),
      ),
    )
    .limit(1);

  if (!previous) return 'skipped';
  // Re-read the stage rather than trusting the client's selection — the deal
  // may have been dragged elsewhere since the board loaded.
  if (previous.stage !== 'qualified') return 'skipped';
  if (
    params.restrictToOwnerUserId &&
    previous.ownerId &&
    previous.ownerId !== params.restrictToOwnerUserId
  ) {
    return 'skipped';
  }

  const gate = await checkGateAndLogWarnings(tx, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    dealId: previous.id,
    dealName: previous.name,
    fromStage: 'qualified',
    toStage: 'lead',
  });
  if (!gate.allowed) return { blocked: previous.name };

  const [updated] = await tx
    .update(deals)
    .set({
      stage: 'lead',
      // The point of the revert — a Lead can't hold a close date.
      expectedCloseDate: null,
      // Re-derive the forecast category unless a manager pinned it (Module 4).
      ...(previous.forecastCategoryOverridden
        ? {}
        : { forecastCategory: deriveForecastCategory('lead') }),
      updatedBy: params.actorUserId,
    })
    .where(
      and(
        eq(deals.id, previous.id),
        eq(deals.tenantId, params.tenantId),
        isNull(deals.deletedAt),
      ),
    )
    .returning();
  if (!updated) return 'skipped';

  await recordActivity(tx, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    entityType: 'deal',
    entityId: updated.id,
    action: 'stage_changed',
    metadata: {
      name: updated.name,
      from: 'qualified',
      to: 'lead',
      reason: 'Bulk revert to Lead — expected close date cleared',
    },
  });

  await recordObservation(tx, params.tenantId, params.actorUserId, {
    observationType: 'deal.stage_changed',
    entityType: 'deal',
    entityId: updated.id,
    metadata: { name: updated.name, from: 'qualified', to: 'lead' },
  });

  const serialized = await loadSerializedDeal(tx, params.tenantId, updated.id);
  if (serialized) {
    await publishRealtimeEvent(tx, {
      type: 'deal.stage_changed',
      tenantId: params.tenantId,
      deal: serialized,
      from: 'qualified',
      to: 'lead',
    });
  }

  return 'moved';
}
