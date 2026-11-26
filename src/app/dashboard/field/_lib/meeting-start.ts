import 'server-only';

import { and, eq } from 'drizzle-orm';

import { meetings } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { canSeeOwner, fieldUserScope } from '@/lib/field/scope';
import type { FieldActor } from '@/lib/field/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Start time of one of the actor's own meetings, so `?m=<id>` (a notification
 * link) can open My day on that meeting's date. Null when it is not theirs or
 * does not exist. Runs inside the page's tenant context.
 */
export async function ownMeetingStart(actor: FieldActor, id: string): Promise<Date | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await tenantTransaction((tx) =>
    tx
      .select({ startAt: meetings.startAt })
      .from(meetings)
      .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, id), eq(meetings.ownerId, actor.userId)))
      .limit(1),
  );
  return row?.startAt ?? null;
}

/**
 * Start time of a meeting the actor may see on the manager board (own, or a
 * rep in their field scope), for `?m=<id>` on Field day. Null otherwise.
 */
export async function scopedMeetingStart(actor: FieldActor, id: string): Promise<Date | null> {
  if (!UUID_RE.test(id)) return null;
  const scope = await fieldUserScope(actor);
  const [row] = await tenantTransaction((tx) =>
    tx
      .select({ startAt: meetings.startAt, ownerId: meetings.ownerId })
      .from(meetings)
      .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, id)))
      .limit(1),
  );
  return row && canSeeOwner(actor, scope, row.ownerId) ? row.startAt : null;
}
