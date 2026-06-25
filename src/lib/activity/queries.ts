import 'server-only';

import { clerkClient } from '@/lib/auth/server';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import {
  type ActivityEntityType,
  type ActivityLog,
  activityLogs,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import {
  buildPage,
  type Cursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PageSize,
} from '@/lib/pagination/cursor';
import { timeQuery } from '@/lib/pagination/timing';

export type ActorSummary = {
  id: string;
  displayName: string;
  imageUrl: string | null;
};

export type ActivityRow = ActivityLog & {
  actor: ActorSummary | null;
};

const ENTITY_DETAIL_LIMIT = 50;

/**
 * Resolve activity-log `actor_user_id` → `ActorSummary`. Three layers:
 *
 *   1. Real Clerk user → look up via Clerk API (batched per page).
 *   2. Seeded-actor id (`seed-actor-...`) → never hits Clerk; reads the
 *      friendly display info from `metadata.actor` written by the seed
 *      script. Keeps Test 1 reading like "Priya Sharma created Acme"
 *      without polluting production tenants.
 *   3. Any other unknown id → fall back to a neutral "Teammate" label.
 *      We intentionally never expose the raw id — defense in depth so a
 *      transient Clerk lookup failure on a real user can't leak
 *      `user_XYZ...` into the feed.
 */
function pickSeededActor(
  row: ActivityLog,
): { id: string; displayName: string; imageUrl: string | null } | null {
  if (!row.actorUserId) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const a = meta.actor as Record<string, unknown> | undefined;
  if (a && typeof a.name === 'string' && a.name.length > 0) {
    return {
      id: row.actorUserId,
      displayName: a.name,
      imageUrl:
        typeof a.imageUrl === 'string' && a.imageUrl.length > 0
          ? a.imageUrl
          : null,
    };
  }
  return null;
}

async function hydrateActors(rows: ActivityLog[]): Promise<ActivityRow[]> {
  // Real Clerk user ids only — seeded actors skip the API call.
  const actorIds = Array.from(
    new Set(
      rows
        .map((r) => r.actorUserId)
        .filter((id): id is string => typeof id === 'string')
        .filter((id) => !id.startsWith('seed-actor-')),
    ),
  );

  type ClerkUser = {
    id: string;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string;
    primaryEmailAddress: { emailAddress: string } | null;
  };
  const userMap = new Map<string, ClerkUser>();

  if (actorIds.length > 0) {
    const client = await clerkClient();
    const userList = await client.users.getUserList({
      userId: actorIds,
      limit: 500,
    });
    for (const u of userList.data) userMap.set(u.id, u as unknown as ClerkUser);
  }

  return rows.map((r) => {
    if (!r.actorUserId) return { ...r, actor: null };

    // 1. Real Clerk user (production path).
    const u = userMap.get(r.actorUserId);
    if (u) {
      const nameParts = [u.firstName, u.lastName].filter(Boolean) as string[];
      const displayName =
        nameParts.length > 0
          ? nameParts.join(' ')
          : u.primaryEmailAddress?.emailAddress ?? 'Teammate';
      return {
        ...r,
        actor: { id: u.id, displayName, imageUrl: u.imageUrl ?? null },
      };
    }

    // 2. Seeded actor (Test 1) — name lives in metadata.
    const seeded = pickSeededActor(r);
    if (seeded) return { ...r, actor: seeded };

    // 3. Unknown id — never expose it. Render as "Teammate".
    return {
      ...r,
      actor: { id: r.actorUserId, displayName: 'Teammate', imageUrl: null },
    };
  });
}

export type ListActivityOptions = {
  cursor?: Cursor | null;
  size?: PageSize;
};

/**
 * Recent activity, paginated by `(created_at desc, id)`. Activity log
 * is high-volume (a stage move adds 1 row, regenerate-embedding adds
 * 0–2 more) so cursor pagination matters here too. Actor hydration
 * stays after the page is built — Clerk lookup batches actor ids so
 * the join is a single round-trip regardless of page size.
 */
export async function listRecentActivity(
  tenantId: string,
  options: ListActivityOptions = {},
): Promise<Page<ActivityRow>> {
  const size = options.size ?? DEFAULT_PAGE_SIZE;

  return await timeQuery('activity.recent', async () => {
    const conditions: SQL[] = [eq(activityLogs.tenantId, tenantId)];
    if (options.cursor) {
      conditions.push(
        sql`(${activityLogs.createdAt}, ${activityLogs.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
      );
    }
    const rows = await tenantTransaction(async (tx) =>
      tx
        .select()
        .from(activityLogs)
        .where(and(...conditions))
        .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
        .limit(size + 1),
    );
    const hydrated = await hydrateActors(rows);
    return buildPage(hydrated, size, (r) => ({
      ts: r.createdAt.toISOString(),
      id: r.id,
    }));
  });
}

export async function listActivityForEntity(
  tenantId: string,
  entityType: ActivityEntityType,
  entityId: string,
  options: { limit?: number } = {},
): Promise<ActivityRow[]> {
  const limit = options.limit ?? ENTITY_DETAIL_LIMIT;

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.tenantId, tenantId),
          eq(activityLogs.entityType, entityType),
          eq(activityLogs.entityId, entityId),
        ),
      )
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit),
  );

  return hydrateActors(rows);
}
