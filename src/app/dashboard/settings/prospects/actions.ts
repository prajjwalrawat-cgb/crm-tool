'use server';

import { revalidatePath } from 'next/cache';

import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { updateProspectSettings, type ProspectSettingsInput } from '@/lib/prospects/settings';

/** Owner/admin: save the Prospect Board settings for the workspace. */
export async function saveProspectSettings(input: ProspectSettingsInput): Promise<{ ok: true } | { ok: false; message: string }> {
  return await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    if (m.role !== 'owner' && m.role !== 'admin') return { ok: false, message: 'Only owners and admins can change this.' };
    const r = await updateProspectSettings(tenant.id, { userId, role: m.role }, input);
    if (!r.ok) return { ok: false, message: r.message };
    revalidatePath('/dashboard/settings/prospects');
    return { ok: true };
  });
}
