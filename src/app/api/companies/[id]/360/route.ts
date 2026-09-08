import { NextResponse, type NextRequest } from 'next/server';

import { resolveAuthorLookup } from '@/app/dashboard/_components/author-lookup';
import { auth } from '@/lib/auth/server';
import {
  ACCOUNT_ROLLUP_LIMIT,
  ACCOUNT_TIMELINE_LIMIT,
  getAccount360,
} from '@/lib/companies/account-360';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import type { TimelineItem } from '@/lib/timeline/queries';

/**
 * GET /api/companies/:id/360?rollup=&timeline=
 *
 * The whole Account 360 view in one response: account fields, the
 * contact rollup, the deal rollup, and the account-wide activity feed.
 * Four panels, one request — a client assembling this from
 * `/contacts?companyId=`, `/deals?companyId=` and two activity reads
 * would pay four round trips and still have to reconcile four
 * independently-paginated snapshots of the same account.
 *
 * The rollups are capped in SQL (see `getAccount360`), so `rollup=200`
 * costs what 200 rows cost — it is a display cap, not a page size, and
 * it is bounded here so a caller cannot turn the endpoint into an
 * unpaginated export of every contact on an account.
 *
 * Scope: tenant membership, exactly like the detail page and like the
 * Company / Contact / Deal endpoints this aggregates. No new permission
 * model — the company is resolved first, so an id from another tenant
 * 404s instead of returning empty rollups that would confirm it exists.
 *
 * Note on naming: the product calls this entity a Company, and the
 * route follows the app's own `/api/<entity>/:id/...` convention rather
 * than introducing an `/api/accounts` alias for the same table.
 */

/** Hard ceiling on `?rollup=`. Above this, callers want the list views. */
const MAX_ROLLUP = 50;
/** Hard ceiling on `?timeline=`. */
const MAX_TIMELINE = 500;

function clamp(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Timeline items carry whole ORM rows so the server component can render
 * them directly. Over the wire they get flattened to the fields a client
 * actually shows — sending `email_messages.html_body` or a comment's
 * mention array to render one line would make the feed the largest part
 * of the payload.
 */
function serializeTimelineItem(
  item: TimelineItem,
  authorNames: Record<string, string>,
): Record<string, unknown> {
  const base = {
    id: item.id,
    kind: item.kind,
    createdAt: item.createdAt.toISOString(),
    source: item.source ?? null,
  };
  if (item.kind === 'activity') {
    return {
      ...base,
      action: item.row.action,
      entityType: item.row.entityType,
      entityId: item.row.entityId,
      actorUserId: item.row.actorUserId,
      actorName: item.row.actorUserId
        ? authorNames[item.row.actorUserId] ?? null
        : null,
      metadata: item.row.metadata,
    };
  }
  if (item.kind === 'note' || item.kind === 'comment') {
    return {
      ...base,
      authorUserId: item.row.authorUserId,
      authorName: authorNames[item.row.authorUserId] ?? null,
      body: item.row.body,
    };
  }
  return {
    ...base,
    actorUserId: item.row.actorUserId,
    actorName: authorNames[item.row.actorUserId] ?? null,
    subject: item.row.subject,
    status: item.row.status,
    provider: item.row.provider,
    toRecipients: item.row.toRecipients,
  };
}

export async function GET(
  req: NextRequest,
  // Typed explicitly rather than via the generated `RouteContext<...>`
  // helper, matching how the sibling routes under /api declare params.
  ctx: { params: Promise<{ id: string }> },
) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const rollupLimit = clamp(
    url.searchParams.get('rollup'),
    ACCOUNT_ROLLUP_LIMIT,
    MAX_ROLLUP,
  );
  const timelineLimit = clamp(
    url.searchParams.get('timeline'),
    ACCOUNT_TIMELINE_LIMIT,
    MAX_TIMELINE,
  );

  const result = await runWithTenantContext(
    { tenantId: orgId, userId },
    async () => {
      await requireMembership();
      return await getAccount360(orgId, id, { rollupLimit, timelineLimit });
    },
  );

  if (!result) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  // One batched lookup for every actor across the whole feed, rather
  // than one per item.
  const actorIds = new Set<string>();
  for (const item of result.timeline) {
    const actor =
      item.kind === 'note' || item.kind === 'comment'
        ? item.row.authorUserId
        : item.row.actorUserId;
    if (actor) actorIds.add(actor);
  }
  if (result.company.ownerId) actorIds.add(result.company.ownerId);
  const authorNames = await resolveAuthorLookup(Array.from(actorIds));

  const c = result.company;
  return NextResponse.json(
    {
      account: {
        id: c.id,
        name: c.name,
        // The product's `domain` is the account's website; `industry` is
        // its type. Named here as they are stored, not renamed in
        // transit, so the payload matches the column a PATCH would set.
        domain: c.domain,
        industry: c.industry,
        ownerId: c.ownerId,
        ownerName: c.ownerId ? authorNames[c.ownerId] ?? null : null,
        customFields: c.customFields,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      },
      contacts: {
        total: result.contacts.total,
        // Where "View All" goes. Same URL the card links to, so the
        // drill-down contract lives in one place.
        viewAllHref: `/dashboard/contacts?companyId=${c.id}`,
        rows: result.contacts.rows.map((r) => ({
          id: r.id,
          firstName: r.firstName,
          lastName: r.lastName,
          title: r.title,
          email: r.email,
          phone: r.phone,
        })),
      },
      deals: {
        total: result.deals.total,
        // Name, not id: the deals filter matches company by name.
        // See account-deals-card.tsx for why.
        viewAllHref: `/dashboard/deals?companyIds=${encodeURIComponent(c.name)}`,
        rows: result.deals.rows.map((r) => ({
          id: r.id,
          name: r.name,
          stage: r.stage,
          amountMinor: r.amountMinor,
          currency: r.currency,
          expectedCloseDate: r.expectedCloseDate,
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
      timeline: result.timeline.map((item) =>
        serializeTimelineItem(item, authorNames),
      ),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
