import 'server-only';

import { clerkClient } from '@clerk/nextjs/server';
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

async function hydrateActors(rows: ActivityLog[]): Promise<ActivityRow[]> {
  const actorIds = Array.from(
    new Set(
      rows
        .map((r) => r.actorUserId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  );

  if (actorIds.length === 0) {
    return rows.map((r) => ({ ...r, actor: null }));
  }

  const client = await clerkClient();
  const userList = await client.users.getUserList({
    userId: actorIds,
    limit: 500,
  });

  const userMap = new Map(userList.data.map((u) => [u.id, u]));

  return rows.map((r) => {
    if (!r.actorUserId) return { ...r, actor: null };
    const u = userMap.get(r.actorUserId);
    if (!u) {
      return {
        ...r,
        actor: { id: r.actorUserId, displayName: r.actorUserId, imageUrl: null },
      };
    }
    const nameParts = [u.firstName, u.lastName].filter(Boolean) as string[];
    const displayName =
      nameParts.length > 0
        ? nameParts.join(' ')
        : u.primaryEmailAddress?.emailAddress ?? r.actorUserId;
    return {
      ...r,
      actor: { id: u.id, displayName, imageUrl: u.imageUrl ?? null },
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
