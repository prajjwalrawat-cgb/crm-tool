import 'server-only';

import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

import { deals, distributionRules, leadAssignments, memberships } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { tenantTransaction } from '@/lib/db-context';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';
import { logger } from '@/lib/observability';

import { distributeLead, listLeadManagers, previousAssignees, type DistributeOutcome } from './distribute';

/**
 * SLA watchdog, unassigned-queue retry, manual reassignment and the
 * first-touch hook. All functions run inside a tenant/system context.
 */

const DEFAULT_MAX_REASSIGNMENTS = 2;

const dueFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
/** "Respond by 16 Nov, 10:30 am IST". Tenant timezone lands with reporting (prompt 3). */
export function formatSlaDue(d: Date): string {
  return `Respond by ${dueFormatter.format(d)} IST`;
}
/** Unassigned leads are retried for this long, then left for a manager. */
const UNASSIGNED_RETRY_HOURS = 6;

export type WatchdogResult = {
  breached: number;
  reassigned: number;
  escalated: number;
  unassigned: number;
};

/**
 * One watchdog pass for a tenant. For every open, untouched assignment past
 * its SLA: if the lead has been reassigned fewer than the rule's
 * `max_reassignments` times, release it and redistribute EXCLUDING everyone
 * who has had it; otherwise escalate to the workspace managers (once).
 *
 * Never reassigns a touched lead: the release is a conditional UPDATE on
 * `first_touch_at IS NULL`, so an owner's touch that lands mid-pass wins.
 */
export async function runSlaWatchdog(tenantId: string, now = new Date()): Promise<WatchdogResult> {
  const result: WatchdogResult = { breached: 0, reassigned: 0, escalated: 0, unassigned: 0 };
  const breached = await tenantTransaction((tx) =>
    tx
      .select({
        id: leadAssignments.id,
        dealId: leadAssignments.dealId,
        assignedTo: leadAssignments.assignedTo,
        escalatedAt: leadAssignments.escalatedAt,
        maxReassignments: distributionRules.maxReassignments,
        dealName: deals.name,
        reassignCount: sql<number>`(
          select count(*)::int from lead_assignments la2
          where la2.deal_id = ${leadAssignments.dealId} and la2.release_reason = 'sla_breach')`,
      })
      .from(leadAssignments)
      .innerJoin(deals, eq(deals.id, leadAssignments.dealId))
      .leftJoin(distributionRules, eq(distributionRules.id, leadAssignments.ruleId))
      .where(
        and(
          eq(leadAssignments.tenantId, tenantId),
          isNull(leadAssignments.firstTouchAt),
          isNull(leadAssignments.releasedAt),
          lt(leadAssignments.slaDueAt, now),
          isNull(deals.deletedAt),
          eq(deals.stage, 'lead'),
        ),
      )
      .orderBy(asc(leadAssignments.slaDueAt))
      .limit(500),
  );
  result.breached = breached.length;
  if (breached.length === 0) return result;

  const managers = await listLeadManagers(tenantId);

  for (const a of breached) {
    const max = a.maxReassignments ?? DEFAULT_MAX_REASSIGNMENTS;
    if (Number(a.reassignCount) < max) {
      const released = await tenantTransaction(async (tx) => {
        const rows = await tx
          .update(leadAssignments)
          .set({ releasedAt: now, releaseReason: 'sla_breach' })
          .where(and(eq(leadAssignments.id, a.id), isNull(leadAssignments.firstTouchAt), isNull(leadAssignments.releasedAt)))
          .returning({ id: leadAssignments.id });
        if (rows.length === 0) return null;
        await tx.update(deals).set({ routingStatus: 'pending' }).where(eq(deals.id, a.dealId));
        await recordActivity(tx, {
          tenantId,
          actorUserId: null,
          entityType: 'deal',
          entityId: a.dealId,
          action: 'automation_note',
          metadata: { name: a.dealName, kind: 'lead_sla_breach', message: 'First-response SLA missed — lead released for reassignment.', fromUserId: a.assignedTo },
        });
        return await previousAssignees(tx, a.dealId);
      });
      if (!released) continue;
      const outcome = await distributeLead({ tenantId, dealId: a.dealId, excludeUserIds: released, assignedBy: 'system:sla', now });
      if (outcome.status === 'assigned') {
        result.reassigned++;
        await notifyAssigned(tenantId, outcome, a.dealName, 'Reassigned to you after a missed SLA');
      } else {
        result.unassigned++;
        await recordNotificationsSafe(
          {
            tenantId,
            actorUserId: null,
            type: 'lead_unassigned',
            title: `Lead needs an owner: ${a.dealName}`,
            subtitle: `SLA missed and no one else is eligible (${outcome.reason}).`,
            entityType: 'deal',
            entityId: a.dealId,
          },
          managers,
        );
      }
    } else if (!a.escalatedAt) {
      await tenantTransaction((tx) =>
        tx.update(leadAssignments).set({ escalatedAt: now }).where(eq(leadAssignments.id, a.id)),
      );
      result.escalated++;
      await recordNotificationsSafe(
        {
          tenantId,
          actorUserId: null,
          type: 'lead_sla_breach',
          title: `SLA missed on ${a.dealName}`,
          subtitle: `Still untouched after ${max} reassignment${max === 1 ? '' : 's'}.`,
          entityType: 'deal',
          entityId: a.dealId,
          metadata: { assignedTo: a.assignedTo },
        },
        managers,
      );
    }
  }
  logger.info('lead sla watchdog', { tenantId, ...result });
  return result;
}

/** Retry leads sitting in the unassigned queue (queued < 6h ago). */
export async function retryUnassignedLeads(tenantId: string, now = new Date()): Promise<{ tried: number; assigned: number }> {
  // ISO string, not the Date: the postgres driver rejects a raw Date bound
  // inside a sql`` fragment ("argument must be of type string… Received Date"),
  // which made every run of the retry cron fail.
  const nowIso = now.toISOString();
  const queued = await tenantTransaction((tx) =>
    tx
      .select({ id: deals.id, name: deals.name })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          inArray(deals.routingStatus, ['unassigned', 'pending']),
          gt(deals.routingQueuedAt, sql`${nowIso}::timestamptz - make_interval(hours => ${UNASSIGNED_RETRY_HOURS})`),
          // 'pending' rows younger than 2 minutes are still in flight.
          lt(deals.routingQueuedAt, sql`${nowIso}::timestamptz - interval '2 minutes'`),
          eq(deals.stage, 'lead'),
          isNull(deals.deletedAt),
        ),
      )
      .orderBy(asc(deals.routingQueuedAt))
      .limit(200),
  );
  let assigned = 0;
  for (const d of queued) {
    const prev = await tenantTransaction((tx) => previousAssignees(tx, d.id));
    const outcome = await distributeLead({ tenantId, dealId: d.id, excludeUserIds: prev, assignedBy: 'system:retry', now });
    if (outcome.status === 'assigned') {
      assigned++;
      await notifyAssigned(tenantId, outcome, d.name, 'New lead assigned to you');
    }
  }
  return { tried: queued.length, assigned };
}

/** Manager reassign: release the open assignment and assign to `toUserId`. */
export async function reassignLead(args: {
  tenantId: string;
  dealId: string;
  toUserId: string;
  actorUserId: string;
  reason: string | null;
  slaMinutes?: number;
}): Promise<{ ok: true; assignmentId: string } | { ok: false; error: string }> {
  const { tenantId, dealId, toUserId, actorUserId } = args;
  const out = await tenantTransaction(async (tx) => {
    const [deal] = await tx
      .select({ id: deals.id, name: deals.name, ownerId: deals.ownerId, deletedAt: deals.deletedAt })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)))
      .for('update');
    if (!deal || deal.deletedAt) return { ok: false as const, error: 'Lead not found.' };
    const [member] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, toUserId), eq(memberships.status, 'active')));
    if (!member) return { ok: false as const, error: 'That user is not an active member of this workspace.' };

    const now = new Date();
    const [open] = await tx
      .update(leadAssignments)
      .set({ releasedAt: now, releaseReason: 'manual_reassign' })
      .where(and(eq(leadAssignments.dealId, dealId), isNull(leadAssignments.releasedAt)))
      .returning({ ruleId: leadAssignments.ruleId });
    let sla = args.slaMinutes ?? 30;
    if (open?.ruleId && args.slaMinutes === undefined) {
      const [r] = await tx.select({ sla: distributionRules.slaMinutes }).from(distributionRules).where(eq(distributionRules.id, open.ruleId));
      if (r) sla = r.sla;
    }
    const [a] = await tx
      .insert(leadAssignments)
      .values({
        tenantId,
        dealId,
        assignedTo: toUserId,
        assignedBy: `user:${actorUserId}`,
        ruleId: open?.ruleId ?? null,
        reason: args.reason,
        assignedAt: now,
        slaDueAt: new Date(now.getTime() + sla * 60_000),
      })
      .returning({ id: leadAssignments.id });
    await tx
      .update(deals)
      .set({ ownerId: toUserId, routingStatus: 'assigned', routingQueuedAt: null, updatedBy: actorUserId })
      .where(eq(deals.id, dealId));
    await recordActivity(tx, {
      tenantId,
      actorUserId,
      entityType: 'deal',
      entityId: dealId,
      action: 'owner_changed',
      metadata: { name: deal.name, from: deal.ownerId ?? null, to: toUserId, reason: args.reason, assignedBy: `user:${actorUserId}` },
    });
    return { ok: true as const, assignmentId: a!.id, name: deal.name };
  });
  if (!out.ok) return out;
  if (toUserId !== actorUserId) {
    await recordNotificationsSafe(
      {
        tenantId,
        actorUserId,
        type: 'lead_assigned',
        title: `Lead assigned to you: ${out.name}`,
        subtitle: args.reason,
        entityType: 'deal',
        entityId: dealId,
      },
      [toUserId],
    );
  }
  return { ok: true, assignmentId: out.assignmentId };
}

export async function notifyAssigned(
  tenantId: string,
  outcome: DistributeOutcome,
  dealName: string,
  title: string,
): Promise<void> {
  if (outcome.status !== 'assigned') return;
  await recordNotificationsSafe(
    {
      tenantId,
      actorUserId: null,
      type: 'lead_assigned',
      title: `${title}: ${dealName}`,
      subtitle: formatSlaDue(outcome.slaDueAt),
      entityType: 'deal',
      entityId: outcome.dealId,
      metadata: { slaDueAt: outcome.slaDueAt.toISOString(), reason: outcome.reason },
    },
    [outcome.userId],
  );
}
