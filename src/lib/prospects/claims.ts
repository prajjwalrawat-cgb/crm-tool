import 'server-only';

import { and, eq } from 'drizzle-orm';

import { memberships, organizationSettings, prospects, users } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';
import { can } from '@/lib/rbac';
import { scopeUsers } from '@/lib/reports/manager/scope';

import { fail, MAX_BULK, UUID_RE, type MutationResult } from './mutations';
import { claimBlock, releaseBlock, type Actor } from './rules';

const DAY_MS = 86_400_000;
const DEFAULT_CLAIM_DAYS = 14;

type Tx = Parameters<Parameters<typeof tenantTransaction>[0]>[0];

async function claimWindowDays(tx: Tx, tenantId: string): Promise<number> {
  const [settings] = await tx
    .select({ days: organizationSettings.prospectClaimDays })
    .from(organizationSettings)
    .where(eq(organizationSettings.tenantId, tenantId))
    .limit(1);
  return settings?.days ?? DEFAULT_CLAIM_DAYS;
}

/** Claim: the row is locked FOR UPDATE, so two simultaneous claimers serialize. */
export async function claimProspect(
  tenantId: string,
  actor: Actor,
  id: string,
  now: Date = new Date(),
): Promise<MutationResult> {
  if (!UUID_RE.test(id)) return fail('not_found');
  return tenantTransaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)))
      .limit(1)
      .for('update');
    if (!cur) return fail('not_found');
    const block = claimBlock(cur, actor, now);
    if (block) return fail(block);

    const days = await claimWindowDays(tx, tenantId);
    await tx
      .update(prospects)
      .set({
        claimedBy: actor.userId,
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + days * DAY_MS),
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)));
    return { ok: true } as MutationResult;
  });
}

export async function releaseProspect(tenantId: string, actor: Actor, id: string): Promise<MutationResult> {
  if (!UUID_RE.test(id)) return fail('not_found');
  return tenantTransaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)))
      .limit(1)
      .for('update');
    if (!cur) return fail('not_found');
    const block = releaseBlock(cur, actor);
    if (block) return fail(block);

    const now = new Date();
    await tx
      .update(prospects)
      .set({ claimedBy: null, claimedAt: null, claimExpiresAt: null, lastActivityAt: now, updatedAt: now })
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)));
    return { ok: true } as MutationResult;
  });
}

/** Manager action: give `toUserId` a fresh claim, overriding any current one. */
export async function reassignClaim(
  tenantId: string,
  actor: Actor,
  id: string,
  toUserId: string,
  now: Date = new Date(),
): Promise<MutationResult> {
  if (!can(actor.role, 'manageProspectClaims')) return fail('no_permission');
  if (!UUID_RE.test(id)) return fail('not_found');

  // Scope reads memberships, not the prospect, so it is resolved before the lock.
  const scope = await scopeUsers({ tenantId, userId: actor.userId, role: actor.role });

  type Outcome = { res: MutationResult; company?: string; actorName?: string };
  const out = await tenantTransaction(async (tx): Promise<Outcome> => {
    const [target] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, toUserId), eq(memberships.status, 'active')))
      .limit(1);
    if (!target) return { res: fail('not_found') };
    if (scope.userIds !== null && !scope.userIds.includes(toUserId)) return { res: fail('out_of_scope') };

    const [cur] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)))
      .limit(1)
      .for('update');
    if (!cur) return { res: fail('not_found') };
    if (cur.deletedAt) return { res: fail('deleted') };
    if (cur.promotedDealId) return { res: fail('promoted') };

    const days = await claimWindowDays(tx, tenantId);
    await tx
      .update(prospects)
      .set({
        claimedBy: toUserId,
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + days * DAY_MS),
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)));

    const [u] = await tx
      .select({ first: users.firstName, last: users.lastName })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1);
    const actorName = [u?.first, u?.last].filter(Boolean).join(' ').trim() || 'A manager';
    return { res: { ok: true } as MutationResult, company: cur.companyName, actorName };
  });

  if (out.res.ok) {
    // After commit and best-effort: a failed notification never undoes the reassignment.
    await recordNotificationsSafe(
      {
        tenantId,
        actorUserId: actor.userId,
        type: 'prospect_claim_assigned',
        title: `${out.actorName} assigned you ${out.company}`,
        entityType: 'prospect',
        entityId: id,
      },
      [toUserId],
    );
  }
  return out.res;
}

export async function bulkReleaseClaims(
  tenantId: string,
  actor: Actor,
  ids: string[],
): Promise<{ released: string[]; skipped: { id: string; reason: string }[] }> {
  if (ids.length > MAX_BULK) return { released: [], skipped: ids.map((id) => ({ id, reason: 'invalid' })) };
  const released: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    try {
      const r = await releaseProspect(tenantId, actor, id);
      if (r.ok) released.push(id);
      else skipped.push({ id, reason: r.error });
    } catch (err) {
      console.error('bulkReleaseClaims: release failed', id, err);
      skipped.push({ id, reason: 'error' });
    }
  }
  return { released, skipped };
}
