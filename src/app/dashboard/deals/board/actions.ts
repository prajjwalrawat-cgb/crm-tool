'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { deals } from '@/db/schema';
import { checkPermission, withTenantSession } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import {
  type BoardStageCursor,
  type DealRow,
  listStageDealsPage,
} from '@/lib/deals/queries';
import { type DealFilters } from '@/lib/deals/filters';
import { DEAL_STAGES } from '@/lib/deals/schema';
import { HOLD_REASONS } from '@/lib/deals/hold';
import {
  isRollbackTransition,
  ROLLBACK_REASONS,
} from '@/lib/deals/stage-governance';
import { requireMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';

import { updateDealStageAction } from '../actions';

const cursorSchema = z.object({
  updatedAt: z.string().min(1),
  id: z.uuid(),
});

const inputSchema = z.object({
  stage: z.enum(DEAL_STAGES),
  cursor: cursorSchema.nullable(),
  // Filters only ever narrow the result set; the security-relevant scope
  // (RLS + owner restriction for sales personas) is recomputed server-side
  // below and cannot be widened by the client.
  filters: z.custom<DealFilters>().optional(),
});

export type LoadMoreStageResult =
  | {
      ok: true;
      rows: DealRow[];
      nextCursor: BoardStageCursor | null;
      hasMore: boolean;
    }
  | { ok: false; message: string };

/**
 * Fetch the next page of deals for one kanban stage column — backs the
 * board's per-column infinite scroll. Authorization mirrors the board page:
 * any tenant member can read, and sales personas are hard-scoped to their
 * own (or unassigned) deals regardless of the filters the client sends.
 */
export async function loadMoreStageDealsAction(
  input: unknown,
): Promise<LoadMoreStageResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid pagination request.' };
  }

  try {
    return await withTenantSession(async ({ tenant, userId }) => {
      const membership = await requireMembership();
      const restrictToOwnerOrUnassigned =
        personaOf(membership.role) === 'sales' ? userId : undefined;

      const page = await listStageDealsPage(
        tenant.id,
        parsed.data.stage,
        parsed.data.cursor,
        {
          restrictToOwnerOrUnassigned,
          filters: parsed.data.filters,
          currentUserId: userId,
        },
      );
      return {
        ok: true as const,
        rows: page.rows,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  } catch {
    return { ok: false, message: 'Could not load more deals.' };
  }
}

/* -------- Bulk stage move -------- */

/**
 * Move several deals to one target stage from the board's select mode.
 *
 * Every deal goes through `updateDealStageAction` — the same path a drag
 * takes — so stage gates, the close-date rules (R1/R3), margin, Won order
 * proof, Hold fields and rollback governance (R2) apply exactly as they do
 * one-by-one. Whatever reasons the move needs (lost / hold / rollback) are
 * collected once by the board and applied to the whole batch.
 *
 * Deals move independently: a refused deal is reported and left where it is,
 * it never sinks the rest of the batch.
 */
const bulkMoveSchema = z.object({
  dealIds: z.array(z.uuid()).min(1).max(200),
  toStage: z.enum(DEAL_STAGES),
  lostReason: z.string().max(1000).optional(),
  holdReason: z.enum(HOLD_REASONS).optional(),
  holdRevisitOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  holdNote: z.string().max(1000).optional(),
  rollbackReason: z.enum(ROLLBACK_REASONS).optional(),
  rollbackNote: z.string().max(1000).optional(),
});

export type BulkMoveInput = z.input<typeof bulkMoveSchema>;

export type BulkMoveResult =
  | {
      ok: true;
      /** Deals actually moved. */
      moved: number;
      /** Already in the target stage, gone, or not yours to move. */
      skipped: number;
      /** Deals the server refused, with the reason it gave. */
      failed: { name: string; message: string }[];
    }
  | { ok: false; message: string };

export async function bulkMoveDealsAction(
  input: BulkMoveInput,
): Promise<BulkMoveResult> {
  const parsed = bulkMoveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Select at least one deal (max 200).' };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;
  const { dealIds, toStage } = parsed.data;

  // Re-read the deals rather than trusting the client's selection: names for
  // the report, current stage to skip no-ops, owner for the sales scope.
  const rows = await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    () =>
      tenantTransaction((tx) =>
        tx
          .select({
            id: deals.id,
            name: deals.name,
            stage: deals.stage,
            ownerId: deals.ownerId,
          })
          .from(deals)
          .where(
            and(
              eq(deals.tenantId, tenant.id),
              inArray(deals.id, dealIds),
              isNull(deals.deletedAt),
            ),
          ),
      ),
  );

  // A sales persona may only move deals they own (or unowned ones) — the
  // same scope the board reads under.
  const restrictToOwner =
    personaOf(membership.role) === 'sales' ? membership.userId : null;

  let moved = 0;
  let skipped = dealIds.length - rows.length;
  const failed: { name: string; message: string }[] = [];

  for (const row of rows) {
    if (row.stage === toStage) {
      skipped += 1;
      continue;
    }
    if (restrictToOwner && row.ownerId && row.ownerId !== restrictToOwner) {
      skipped += 1;
      continue;
    }

    const rollingBack = isRollbackTransition(row.stage, toStage);
    const result = await updateDealStageAction({
      id: row.id,
      stage: toStage,
      reason: toStage === 'lost' ? parsed.data.lostReason : undefined,
      holdReason: toStage === 'hold' ? parsed.data.holdReason : undefined,
      holdRevisitOn: toStage === 'hold' ? parsed.data.holdRevisitOn : undefined,
      holdNote: toStage === 'hold' ? parsed.data.holdNote : undefined,
      // The board warns that Lead drops the close date before confirming.
      clearCloseDate: toStage === 'lead' ? true : undefined,
      rollbackReason: rollingBack ? parsed.data.rollbackReason : undefined,
      rollbackNote: rollingBack ? parsed.data.rollbackNote : undefined,
    });

    if (result.ok) {
      if (result.changed) moved += 1;
      else skipped += 1;
    } else {
      failed.push({ name: row.name, message: result.message });
    }
  }

  if (moved > 0) revalidatePath('/dashboard');

  return { ok: true as const, moved, skipped, failed };
}
