import 'server-only';

import { and, eq } from 'drizzle-orm';

import { meetings, memberships, type Meeting } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { can } from '@/lib/rbac';
import { scopeIncludes, scopeUsers, type ReportScope } from '@/lib/reports/manager/scope';

import { asActor, isUuid, type Tx } from './internal';
import { FieldError, type FieldActor } from './types';

/**
 * Who may see and act on whose meetings.
 *   member/viewer → self; manager → scopeUsers subtree; owner/admin → tenant.
 * Out-of-scope meetings are `not_found` (existence is not leaked). Owner-only
 * actions on an in-scope meeting the actor does not own are `forbidden`.
 */

export function fieldUserScope(actor: FieldActor): Promise<ReportScope> {
  return asActor(actor, () => scopeUsers(actor));
}

/** True when the actor may see `ownerId`'s meetings. */
export async function canSeeOwner(actor: FieldActor, ownerId: string): Promise<boolean> {
  if (ownerId === actor.userId) return true;
  if (!can(actor.role, 'viewFieldTeam')) return false;
  return scopeIncludes(await fieldUserScope(actor), ownerId);
}

/** Viewers are read-only. */
export function assertCanWrite(actor: FieldActor): void {
  if (actor.role === 'viewer') throw new FieldError('forbidden', 'Viewers cannot change meetings');
}

/** The actor may create / edit meetings owned by `ownerId` (self, or a rep in scope). */
export async function assertCanActFor(actor: FieldActor, ownerId: string): Promise<void> {
  assertCanWrite(actor);
  if (ownerId === actor.userId) return;
  if (!(await canSeeOwner(actor, ownerId))) {
    throw new FieldError('forbidden', 'You can only plan meetings for reps in your team');
  }
  const [member] = await asActor(actor, () =>
    tenantTransaction((tx) =>
      tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, actor.tenantId),
            eq(memberships.userId, ownerId),
            eq(memberships.status, 'active'),
          ),
        )
        .limit(1),
    ),
  );
  if (!member) throw new FieldError('validation', 'Meeting owner is not an active member of this workspace');
}

async function lockMeeting(tx: Tx, actor: FieldActor, id: string): Promise<Meeting> {
  if (!isUuid(id)) throw new FieldError('not_found', 'Meeting not found');
  const [row] = await tx
    .select()
    .from(meetings)
    .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, id)))
    .limit(1)
    .for('update');
  if (!row) throw new FieldError('not_found', 'Meeting not found');
  return row;
}

/** Lock a meeting the actor may manage (own, or in scope). */
export async function lockManagedMeeting(tx: Tx, actor: FieldActor, id: string): Promise<Meeting> {
  assertCanWrite(actor);
  const row = await lockMeeting(tx, actor, id);
  if (!(await canSeeOwner(actor, row.ownerId))) throw new FieldError('not_found', 'Meeting not found');
  return row;
}

/** Lock a meeting for an owner-only action (check-in, check-out, en-route, outcome). */
export async function lockOwnedMeeting(tx: Tx, actor: FieldActor, id: string): Promise<Meeting> {
  assertCanWrite(actor);
  const row = await lockMeeting(tx, actor, id);
  if (row.ownerId === actor.userId) return row;
  if (await canSeeOwner(actor, row.ownerId)) {
    throw new FieldError('forbidden', 'Only the meeting owner can do this');
  }
  throw new FieldError('not_found', 'Meeting not found');
}
