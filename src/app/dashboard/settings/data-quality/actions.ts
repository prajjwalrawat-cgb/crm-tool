'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { mergeRecords } from '@/lib/dedup/queries';

export type MergeActionResult =
  | { ok: true; repointed: Record<string, number> }
  | { ok: false; message: string };

const mergeSchema = z.object({
  winnerId: z.uuid(),
  loserId: z.uuid(),
});

async function doMerge(
  entityType: 'company' | 'contact',
  permission: 'deleteCompanies' | 'deleteContacts',
  input: unknown,
): Promise<MergeActionResult> {
  const parsed = mergeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid merge request.' };
  // Merge soft-deletes the loser — gate at the delete tier (owner/admin).
  const gate = await checkPermission(permission);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const res = await mergeRecords(
        entityType,
        tenant.id,
        parsed.data.winnerId,
        parsed.data.loserId,
        membership.userId,
      );
      if (!res.ok) return res;
      revalidatePath('/dashboard/settings/data-quality');
      revalidatePath(`/dashboard/${entityType === 'company' ? 'companies' : 'contacts'}`);
      return { ok: true, repointed: res.repointed };
    },
  );
}

export async function mergeCompaniesAction(input: {
  winnerId: string;
  loserId: string;
}): Promise<MergeActionResult> {
  return doMerge('company', 'deleteCompanies', input);
}

export async function mergeContactsAction(input: {
  winnerId: string;
  loserId: string;
}): Promise<MergeActionResult> {
  return doMerge('contact', 'deleteContacts', input);
}
