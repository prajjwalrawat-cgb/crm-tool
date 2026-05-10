import 'server-only';

import { clerkClient } from '@clerk/nextjs/server';
import { and, desc, eq } from 'drizzle-orm';

import {
  type ActivityEntityType,
  type ActivityLog,
  activityLogs,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

export type ActorSummary = {
  id: string;
  displayName: string;
  imageUrl: string | null;
};

export type ActivityRow = ActivityLog & {
  actor: ActorSummary | null;
};

const DEFAULT_LIMIT = 50;

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

export async function listRecentActivity(
  tenantId: string,
  options: { limit?: number } = {},
): Promise<ActivityRow[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.tenantId, tenantId))
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit),
  );

  return hydrateActors(rows);
}

export async function listActivityForEntity(
  tenantId: string,
  entityType: ActivityEntityType,
  entityId: string,
  options: { limit?: number } = {},
): Promise<ActivityRow[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;

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
