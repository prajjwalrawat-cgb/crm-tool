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
 *
 * Pool rule: `fieldUserScope` opens its own transaction, so callers compute the
 * scope BEFORE their own `tenantTransaction` and pass it to the lock helpers.
 * Nothing here opens a second connection while a row lock is held.
 */

export function fieldUserScope(actor: FieldActor): Promise<ReportScope> {
  return asActor(actor, () => scopeUsers(actor));
}

/** True when the actor may see `ownerId`'s meetings, given the actor's precomputed scope. */
export function canSeeOwner(actor: FieldActor, scope: ReportScope, ownerId: string): boolean {
  if (ownerId === actor.userId) return true;
  return can(actor.role, 'viewFieldTeam') && scopeIncludes(scope, ownerId);
}

/** Viewers are read-only. */
export function assertCanWrite(actor: FieldActor): void {
  if (actor.role === 'viewer') throw new FieldError('forbidden', 'Viewers cannot change meetings');
}

async function assertActiveMember(tx: Tx, actor: FieldActor, ownerId: string): Promise<void> {
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, ownerId), eq(memberships.status, 'active')),
    )
    .limit(1);
  if (!member) throw new FieldError('validation', 'Meeting owner is not an active member of this workspace');
}

/** Same as `assertCanActFor`, but on the caller's open transaction with a precomputed scope. */
export async function assertCanActForTx(tx: Tx, actor: FieldActor, scope: ReportScope, ownerId: string): Promise<void> {
  assertCanWrite(actor);
  if (ownerId === actor.userId) return;
  if (typeof ownerId !== 'string' || !ownerId) throw new FieldError('validation', 'Meeting owner is required');
  if (!canSeeOwner(actor, scope, ownerId)) {
    throw new FieldError('forbidden', 'You can only plan meetings for reps in your team');
  }
  await assertActiveMember(tx, actor, ownerId);
}

/**
 * The actor may create / edit meetings owned by `ownerId` (self, or an active
 * member in scope). Opens its own transactions: call it before any transaction
 * of yours, never inside one (inside one, use `assertCanActForTx`).
 */
export async function assertCanActFor(actor: FieldActor, ownerId: string, scopeIn?: ReportScope): Promise<void> {
  assertCanWrite(actor);
  if (ownerId === actor.userId) return;
  const scope = scopeIn ?? (await fieldUserScope(actor));
  await asActor(actor, () => tenantTransaction((tx) => assertCanActForTx(tx, actor, scope, ownerId)));
}

/** Read a meeting without a lock (pre-transaction planning reads). */
export async function readMeeting(tx: Tx, actor: FieldActor, id: string): Promise<Meeting> {
  if (!isUuid(id)) throw new FieldError('not_found', 'Meeting not found');
  const [row] = await tx
    .select()
    .from(meetings)
    .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, id)))
    .limit(1);
  if (!row) throw new FieldError('not_found', 'Meeting not found');
  return row;
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
export async function lockManagedMeeting(tx: Tx, actor: FieldActor, scope: ReportScope, id: string): Promise<Meeting> {
  assertCanWrite(actor);
  const row = await lockMeeting(tx, actor, id);
  if (!canSeeOwner(actor, scope, row.ownerId)) throw new FieldError('not_found', 'Meeting not found');
  return row;
}

/** Lock a meeting for an owner-only action (check-in, check-out, en-route, outcome). */
export async function lockOwnedMeeting(tx: Tx, actor: FieldActor, scope: ReportScope, id: string): Promise<Meeting> {
  assertCanWrite(actor);
  const row = await lockMeeting(tx, actor, id);
  if (row.ownerId === actor.userId) return row;
  if (canSeeOwner(actor, scope, row.ownerId)) throw new FieldError('forbidden', 'Only the meeting owner can do this');
  throw new FieldError('not_found', 'Meeting not found');
}
