'use server';

import { z } from 'zod';

import { withTenantSession } from '@/lib/auth-guard';
import {
  type BoardStageCursor,
  type DealRow,
  listStageDealsPage,
} from '@/lib/deals/queries';
import { type DealFilters } from '@/lib/deals/filters';
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
