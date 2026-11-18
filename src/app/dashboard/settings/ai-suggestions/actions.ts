'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { organizationSettings } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';

/** Owner/admin: turn AI field suggestions on or off for the workspace. */
export async function setAiSuggestionsEnabled(enabled: boolean): Promise<{ ok: true } | { ok: false; message: string }> {
  return await withTenantSession(async ({ tenant }) => {
    const m = await requireMembership();
    if (m.role !== 'owner' && m.role !== 'admin') return { ok: false, message: 'Only owners and admins can change this.' };
    const updated = await tenantTransaction((tx) =>
      tx
        .update(organizationSettings)
        .set({ aiSuggestionsEnabled: enabled === true })
        .where(eq(organizationSettings.tenantId, tenant.id))
        .returning({ id: organizationSettings.tenantId }),
    );
    if (!updated.length) return { ok: false, message: 'Save the organization settings once before turning this on.' };
    revalidatePath('/dashboard/settings/ai-suggestions');
    return { ok: true };
  });
}
