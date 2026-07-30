import { NextResponse, type NextRequest } from 'next/server';

import { resolveAuthorLookup } from '@/app/dashboard/_components/author-lookup';
import { auth } from '@/lib/auth/server';
import { listDealDateChanges } from '@/lib/deals/date-history';
import { getDealById } from '@/lib/deals/queries';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';

/**
 * GET /api/deals/:id/date-history
 *
 * A deal's full close-date change log, newest first, with actor display names
 * resolved. Backs the "Date history" section on the deal detail page, which
 * fetches it on expand rather than paying for it on every page render.
 *
 * Scope: tenant membership. Reads run under the caller's tenant context so RLS
 * confines them to their own workspace, and the deal is resolved first so an id
 * from another tenant 404s instead of returning an empty list.
 */
export async function GET(
  _req: NextRequest,
  // Typed explicitly rather than via the generated `RouteContext<...>` helper,
  // matching how the dynamic page routes here declare their params.
  ctx: { params: Promise<{ id: string }> },
) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  const result = await runWithTenantContext({ tenantId: orgId, userId }, async () => {
    // Membership check, and it establishes the same read scope the detail page
    // uses (any member may open a deal in their workspace).
    await requireMembership();

    const deal = await getDealById(orgId, id);
    if (!deal) return null;

    const entries = await listDealDateChanges(orgId, id);
    return { deal, entries };
  });

  if (!result) {
    return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
  }

  // One batch lookup for every actor in the log.
  const actorIds = Array.from(
    new Set(
      result.entries
        .map((e) => e.changedBy)
        .filter((v): v is string => v != null && v.length > 0),
    ),
  );
  const actorNames = await resolveAuthorLookup(actorIds);

  return NextResponse.json(
    {
      dealId: id,
      originalCloseDate: result.deal.originalCloseDate,
      expectedCloseDate: result.deal.expectedCloseDate,
      pushCount: result.deal.pushCount,
      totalSlipDays: result.deal.totalSlipDays,
      lastPushedAt: result.deal.lastPushedAt?.toISOString() ?? null,
      changes: result.entries.map((e) => ({
        id: e.id,
        oldCloseDate: e.oldCloseDate,
        newCloseDate: e.newCloseDate,
        changedBy: e.changedBy,
        changedByName: e.changedBy ? actorNames[e.changedBy] ?? null : null,
        changedAt: e.changedAt.toISOString(),
        reason: e.reason,
        isPush: e.isPush,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
