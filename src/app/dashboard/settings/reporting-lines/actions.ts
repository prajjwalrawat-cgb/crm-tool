'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { memberships, organizationSettings } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import { can } from '@/lib/rbac';

type Result = { ok: true } | { ok: false; error: string };

const Id = z.string().min(1).max(100);

/**
 * Set who a member reports to (0074). Admin tier only. Refuses a line that
 * would make a loop (A → B → … → A), since a manager's report scope is the
 * recursive subtree below them.
 */
export async function setReportsToAction(userId: string, reportsToUserId: string | null): Promise<Result> {
  if (!Id.safeParse(userId).success || (reportsToUserId !== null && !Id.safeParse(reportsToUserId).success)) {
    return { ok: false, error: 'Invalid member.' };
  }
  if (reportsToUserId === userId) return { ok: false, error: 'Someone can’t report to themselves.' };
  return await withTenantSession(async ({ tenant }) => {
    const me = await requireMembership();
    if (!can(me.role, 'manageMembers')) return { ok: false, error: 'Only admins can change reporting lines.' };
    const out = await tenantTransaction(async (tx): Promise<Result> => {
      const rows = await tx
        .select({ userId: memberships.userId, reportsTo: memberships.reportsToUserId })
        .from(memberships)
        .where(eq(memberships.tenantId, tenant.id));
      const parent = new Map(rows.map((r) => [r.userId, r.reportsTo]));
      if (!parent.has(userId)) return { ok: false, error: 'Member not found.' };
      if (reportsToUserId !== null) {
        if (!parent.has(reportsToUserId)) return { ok: false, error: 'Manager not found.' };
        // Walk up from the new manager; reaching `userId` means a loop.
        let cur: string | null | undefined = reportsToUserId;
        for (let i = 0; cur && i < 100; i++) {
          if (cur === userId) return { ok: false, error: 'That would create a loop in the reporting line.' };
          cur = parent.get(cur) ?? null;
        }
      }
      await tx
        .update(memberships)
        .set({ reportsToUserId })
        .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, userId)));
      return { ok: true };
    });
    if (out.ok) revalidatePath('/dashboard/settings/reporting-lines');
    return out;
  });
}

/** Turn the AI reports narrative on/off for the workspace (admin tier). */
export async function setReportNarrativeAction(enabled: boolean): Promise<Result> {
  return await withTenantSession(async ({ tenant }) => {
    const me = await requireMembership();
    if (!can(me.role, 'manageMembers')) return { ok: false, error: 'Only admins can change this.' };
    await tenantTransaction((tx) =>
      tx
        .insert(organizationSettings)
        .values({ tenantId: tenant.id, reportNarrativeEnabled: enabled })
        .onConflictDoUpdate({ target: organizationSettings.tenantId, set: { reportNarrativeEnabled: enabled } }),
    );
    revalidatePath('/dashboard/settings/reporting-lines');
    return { ok: true };
  });
}
