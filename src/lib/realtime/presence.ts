import 'server-only';

import { db } from '@/db';

import { type PresenceMember } from './events';
import { publishRealtimeEvent } from './publisher';

/**
 * Per-tenant presence registry. Keyed by tenantId → userId → entry.
 * `count` tracks open connections so a single user with two tabs doesn't
 * disappear from presence when one closes.
 *
 * In-memory only: works on a single Node process. For multi-instance
 * deploys you'd back this with Redis or a Postgres `presence` table; the
 * publish path already uses `pg_notify`, so the broadcast layer would
 * generalize cleanly. Documented under future scaling concerns.
 */
type Entry = {
  displayName: string | null;
  imageUrl: string | null;
  count: number;
};

const presence = new Map<string, Map<string, Entry>>();

export type PresenceUser = {
  userId: string;
  displayName: string | null;
  imageUrl: string | null;
};

function snapshotMembers(tenantId: string): PresenceMember[] {
  const tenantMap = presence.get(tenantId);
  if (!tenantMap) return [];
  return Array.from(tenantMap.entries()).map(([userId, entry]) => ({
    userId,
    displayName: entry.displayName,
    imageUrl: entry.imageUrl,
  }));
}

async function broadcastPresence(tenantId: string): Promise<void> {
  try {
    await publishRealtimeEvent(db, {
      type: 'presence.snapshot',
      tenantId,
      members: snapshotMembers(tenantId),
    });
  } catch (err) {
    // Presence is best-effort. Failure here shouldn't take down the SSE
    // connection it was triggered from — log and move on.
    console.error('[presence] broadcast failed:', err);
  }
}

export async function trackPresence(
  tenantId: string,
  user: PresenceUser,
): Promise<void> {
  let tenantMap = presence.get(tenantId);
  if (!tenantMap) {
    tenantMap = new Map();
    presence.set(tenantId, tenantMap);
  }
  const existing = tenantMap.get(user.userId);
  tenantMap.set(user.userId, {
    displayName: user.displayName,
    imageUrl: user.imageUrl,
    count: (existing?.count ?? 0) + 1,
  });
  await broadcastPresence(tenantId);
}

export async function untrackPresence(
  tenantId: string,
  userId: string,
  options: { notify?: boolean } = {},
): Promise<void> {
  const { notify = true } = options;
  const tenantMap = presence.get(tenantId);
  if (!tenantMap) return;
  const entry = tenantMap.get(userId);
  if (!entry) return;

  if (entry.count > 1) {
    tenantMap.set(userId, { ...entry, count: entry.count - 1 });
  } else {
    tenantMap.delete(userId);
  }
  if (tenantMap.size === 0) presence.delete(tenantId);

  // `notify: false` removes the user from the registry WITHOUT broadcasting
  // a "left" snapshot. Used when the SSE stream is torn down by its own
  // lifetime cap (not a real disconnect): the client's EventSource reconnects
  // within seconds and re-tracks, so suppressing the broadcast avoids other
  // members seeing the user flicker offline→online every cycle. The reconnect's
  // trackPresence re-broadcasts an up-to-date snapshot.
  if (notify) await broadcastPresence(tenantId);
}

/** Read-only snapshot for the initial SSE write so reconnecting clients get state immediately. */
export function getPresenceSnapshot(tenantId: string): PresenceMember[] {
  return snapshotMembers(tenantId);
}
