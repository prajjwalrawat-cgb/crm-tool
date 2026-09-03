import { NextResponse, type NextRequest } from 'next/server';

import { resolveAuthorLookup } from '@/app/dashboard/_components/author-lookup';
import { auth } from '@/lib/auth/server';
import {
  AUDIT_PAGE_SIZE,
  dealAuditSummary,
  listDealAuditLog,
} from '@/lib/deals/audit-log';
import { getDealById } from '@/lib/deals/queries';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';

/**
 * GET /api/deals/:id/audit-log?cursor=&limit=
 *
 * A deal's unified governance audit trail (stage / close date / amount),
 * newest first, keyset-paginated, with actor display names resolved. Backs the
 * Audit tab on the deal detail page, which fetches it on expand rather than
 * paying for it on every page render — the same shape as `date-history`.
 *
 * Scope: tenant membership, matching the detail page itself. Reads run under
 * the caller's tenant context so RLS confines them to their own workspace, and
 * the deal is resolved first so an id from another tenant 404s rather than
 * returning an empty list (which would confirm the id exists).
 */
export async function GET(
  _req: NextRequest,
  // Typed explicitly rather than via the generated `RouteContext<...>` helper,
  // matching how the sibling routes here declare their params.
  ctx: { params: Promise<{ id: string }> },
) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const url = new URL(_req.url);
  const cursor = url.searchParams.get('cursor');
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? limitParam
    : AUDIT_PAGE_SIZE;

  const result = await runWithTenantContext({ tenantId: orgId, userId }, async () => {
    await requireMembership();

    const deal = await getDealById(orgId, id);
    if (!deal) return null;

    const [page, summary] = await Promise.all([
      listDealAuditLog(orgId, id, { limit, cursor }),
      dealAuditSummary(orgId, id),
    ]);
    return { deal, page, summary };
  });

  if (!result) {
    return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
  }

  // One batch lookup for every actor on this page.
  const actorIds = Array.from(
    new Set(
      result.page.entries
        .map((e) => e.changedBy)
        .filter((v): v is string => v != null && v.length > 0),
    ),
  );
  const actorNames = await resolveAuthorLookup(actorIds);

  return NextResponse.json(
    {
      dealId: id,
      currency: result.deal.currency,
      pushCount: result.deal.pushCount,
      rollbackCount: result.deal.rollbackCount,
      quotaWeight: Number(result.deal.quotaWeight),
      summary: result.summary,
      nextCursor: result.page.nextCursor,
      entries: result.page.entries.map((e) => ({
        id: e.id,
        changedBy: e.changedBy,
        changedByName: e.changedBy ? actorNames[e.changedBy] ?? null : null,
        changedAt: e.changedAt.toISOString(),
        fieldName: e.fieldName,
        oldValue: e.oldValue,
        newValue: e.newValue,
        changeType: e.changeType,
        reasonCode: e.reasonCode,
        reasonNote: e.reasonNote,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
