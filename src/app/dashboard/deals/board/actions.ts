'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission, withTenantSession } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import {
  type BoardStageCursor,
  type DealRow,
  listStageDealsPage,
} from '@/lib/deals/queries';
import { type DealFilters } from '@/lib/deals/filters';
import { revertDealToLead } from '@/lib/deals/revert-to-lead';
import { queueDealScoreRecompute } from '@/lib/deals/scoring/queue';
import { DEAL_STAGES } from '@/lib/deals/schema';
import { requireMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';

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

/* -------- TEMPORARY: bulk revert Qualified → Lead -------- */

/**
 * Cleanup affordance for the Lead close-date rollout. Introducing
 * `violatesLeadCloseDate` pushed every dated Lead deal into Qualified, and
 * this lets the team put the ones that were misclassified back — in bulk,
 * from the board, instead of one edit at a time.
 *
 * The rule still holds afterwards: a Lead can't carry a close date, so the
 * revert CLEARS `expected_close_date`. That's the trade the team accepts to
 * get the stage right; the date is re-entered when the deal re-qualifies.
 *
 * Scoped deliberately narrow — Qualified is the only source stage, since
 * that's the only place the migration put deals. Remove once the backlog is
 * sorted.
 */
const revertToLeadSchema = z.object({
  dealIds: z.array(z.uuid()).min(1).max(200),
});

export type RevertToLeadResult =
  | {
      ok: true;
      /** Deals actually moved to Lead. */
      moved: number;
      /** Deals left alone (already moved, out of scope, or not visible to you). */
      skipped: number;
      /** Names of deals a stage gate refused to send back to Lead. */
      blocked: string[];
    }
  | { ok: false; message: string };

export async function revertQualifiedDealsToLeadAction(
  input: unknown,
): Promise<RevertToLeadResult> {
  const parsed = revertToLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Select at least one deal (max 200).' };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      // A sales persona may only revert deals they own (or unowned ones) —
      // same scope the board reads under.
      const restrictToOwner =
        personaOf(membership.role) === 'sales' ? membership.userId : null;

      let moved = 0;
      let skipped = 0;
      const blocked: string[] = [];
      const rescore: string[] = [];

      // One transaction per deal: a gate block or a row that moved out from
      // under us skips that deal instead of losing the whole batch.
      for (const dealId of parsed.data.dealIds) {
        const outcome = await tenantTransaction((tx) =>
          revertDealToLead(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            dealId,
            restrictToOwnerUserId: restrictToOwner,
          }),
        );

        if (outcome === 'moved') {
          moved += 1;
          rescore.push(dealId);
        } else if (outcome === 'skipped') {
          skipped += 1;
        } else {
          blocked.push(outcome.blocked);
        }
      }

      // Post-commit, best effort — a failed enqueue must not undo the moves.
      for (const id of rescore) {
        await queueDealScoreRecompute(tenant.id, id, 'stage_changed');
      }

      if (moved > 0) {
        revalidatePath('/dashboard/deals');
        revalidatePath('/dashboard/deals/board');
        revalidatePath('/dashboard/activity');
        revalidatePath('/dashboard');
      }

      return { ok: true as const, moved, skipped, blocked };
    },
  );
}
