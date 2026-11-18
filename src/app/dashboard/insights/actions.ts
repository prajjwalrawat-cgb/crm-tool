'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { deals, leadSourceCost, savedReports } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { reassignLead } from '@/lib/lead-capture/sla';
import { requireMembership } from '@/lib/membership';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';
import { can } from '@/lib/rbac';
import { METRIC_KEYS } from '@/lib/reports/metrics';
import { scopeIncludes, scopeUsers } from '@/lib/reports/manager/scope';
import { peopleById, repsInScope } from '@/lib/reports/manager/services';

type Result = { ok: true; id?: string } | { ok: false; error: string };

/* --------------------------------------------------------- saved reports */

const ScheduleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly']),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).optional(),
    recipients: z.array(z.string().min(1).max(100)).max(50),
    format: z.literal('email'),
  })
  .nullable();

const SavedSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  definition: z.object({
    metrics: z.array(z.enum(METRIC_KEYS as [string, ...string[]])).min(1).max(12),
    groupBy: z.enum(['day', 'owner', 'source']).nullable().optional(),
    filters: z.object({ ownerId: z.string().nullable().optional(), sourceId: z.string().nullable().optional() }).optional(),
    range: z.enum(['today', '7d', '30d', 'mtd']),
    compare: z.enum(['previous', 'yoy']).nullable().optional(),
  }),
  schedule: ScheduleSchema,
});

export async function saveReportAction(input: z.input<typeof SavedSchema>): Promise<Result> {
  const p = SavedSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? 'Invalid report.' };
  return await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    // Only managers and above may send a schedule to other people.
    const others = (p.data.schedule?.recipients ?? []).filter((r) => r !== userId);
    if (others.length && !can(m.role, 'inviteMembers')) return { ok: false, error: 'Only managers can schedule a report for other people.' };
    if (p.data.id) {
      const rows = await tenantTransaction((tx) =>
        tx
          .update(savedReports)
          .set({ name: p.data.name, definition: p.data.definition, schedule: p.data.schedule })
          .where(and(eq(savedReports.id, p.data.id!), eq(savedReports.tenantId, tenant.id), eq(savedReports.ownerId, userId)))
          .returning({ id: savedReports.id }),
      );
      if (!rows[0]) return { ok: false, error: 'Report not found.' };
      revalidatePath('/dashboard/insights/saved');
      return { ok: true, id: rows[0].id };
    }
    const [row] = await tenantTransaction((tx) =>
      tx
        .insert(savedReports)
        .values({ tenantId: tenant.id, ownerId: userId, name: p.data.name, definition: p.data.definition, schedule: p.data.schedule })
        .returning({ id: savedReports.id }),
    );
    revalidatePath('/dashboard/insights/saved');
    return { ok: true, id: row!.id };
  });
}

export async function deleteSavedReportAction(id: string): Promise<Result> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: 'Invalid id.' };
  return await withTenantSession(async ({ tenant, userId }) => {
    await tenantTransaction((tx) =>
      tx.delete(savedReports).where(and(eq(savedReports.id, id), eq(savedReports.tenantId, tenant.id), eq(savedReports.ownerId, userId))),
    );
    revalidatePath('/dashboard/insights/saved');
    return { ok: true };
  });
}

/* ------------------------------------------------------ source spend */

const SpendSchema = z.object({
  sourceId: z.uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  spend: z.number().min(0).max(1e12),
});

/** Inline-edit a month's spend on the Source ROI table (manager and above). */
export async function setSourceSpendAction(input: z.input<typeof SpendSchema>): Promise<Result> {
  const p = SpendSchema.safeParse(input);
  if (!p.success) return { ok: false, error: 'Enter a month and a spend of 0 or more.' };
  return await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    if (!can(m.role, 'manageForecast')) return { ok: false, error: 'Only managers can edit spend.' };
    const month = `${p.data.month}-01`;
    await tenantTransaction((tx) =>
      tx
        .insert(leadSourceCost)
        .values({ tenantId: tenant.id, sourceId: p.data.sourceId, month, spend: String(p.data.spend), updatedBy: userId })
        .onConflictDoUpdate({
          target: [leadSourceCost.tenantId, leadSourceCost.sourceId, leadSourceCost.month],
          set: { spend: String(p.data.spend), updatedBy: userId, updatedAt: new Date() },
        }),
    );
    revalidatePath('/dashboard/insights/sources');
    return { ok: true };
  });
}

/* ---------------------------------------------- stale / breach actions */

/** Nudge a deal's owner (in-app notification). The deal must be in the actor's report scope. */
export async function nudgeOwnerAction(dealId: string): Promise<Result> {
  if (!z.uuid().safeParse(dealId).success) return { ok: false, error: 'Invalid deal.' };
  return await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    const scope = await scopeUsers({ tenantId: tenant.id, userId, role: m.role });
    const [d] = await tenantTransaction((tx) =>
      tx.select({ name: deals.name, ownerId: deals.ownerId }).from(deals).where(and(eq(deals.id, dealId), eq(deals.tenantId, tenant.id))),
    );
    if (!d || !d.ownerId || !scopeIncludes(scope, d.ownerId)) return { ok: false, error: 'Deal not found in your team.' };
    if (d.ownerId === userId) return { ok: false, error: 'This is your own deal.' };
    await recordNotificationsSafe(
      {
        tenantId: tenant.id,
        actorUserId: userId,
        type: 'task_due_soon',
        title: `Follow up: ${d.name}`,
        subtitle: 'Your manager flagged this deal as going quiet.',
        entityType: 'deal',
        entityId: dealId,
        metadata: { kind: 'report_nudge' },
      },
      [d.ownerId],
    );
    return { ok: true };
  });
}

/** Reassign a deal from a report (assignDeals permission; both owners must be in scope). */
export async function reassignFromReportAction(dealId: string, toUserId: string): Promise<Result> {
  if (!z.uuid().safeParse(dealId).success || !toUserId) return { ok: false, error: 'Invalid input.' };
  return await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    if (!can(m.role, 'assignDeals') && m.role !== 'admin') return { ok: false, error: 'You can’t reassign deals.' };
    const scope = await scopeUsers({ tenantId: tenant.id, userId, role: m.role });
    const [d] = await tenantTransaction((tx) =>
      tx.select({ ownerId: deals.ownerId }).from(deals).where(and(eq(deals.id, dealId), eq(deals.tenantId, tenant.id))),
    );
    if (!d || (d.ownerId && !scopeIncludes(scope, d.ownerId)) || !scopeIncludes(scope, toUserId)) {
      return { ok: false, error: 'Deal or user is outside your team.' };
    }
    const r = await reassignLead({ tenantId: tenant.id, dealId, toUserId, actorUserId: userId, reason: 'Reassigned from reports' });
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath('/dashboard/insights/stale');
    revalidatePath('/dashboard/insights/sla');
    return { ok: true };
  });
}

/** Members a manager can reassign to (their scope). */
export async function listAssignableAction(): Promise<Array<{ id: string; name: string }>> {
  return await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    const scope = await scopeUsers({ tenantId: tenant.id, userId, role: m.role });
    const ids = (await repsInScope(scope)).filter((id) => scopeIncludes(scope, id));
    const people = await peopleById(ids);
    return ids.map((id) => ({ id, name: people.get(id)?.name ?? id })).sort((a, b) => a.name.localeCompare(b.name));
  });
}
