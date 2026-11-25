'use server';

import { revalidatePath } from 'next/cache';

import { checkPermission, withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { saveFieldSettings } from '@/lib/field/settings';
import { FieldError } from '@/lib/field/types';

export type FieldSettingsInput = {
  checkinRadiusM: number;
  graceMin: number;
  momDueHours: number;
  trackingStart: string;
  trackingEnd: string;
};

/** Owner/admin: save the workspace's Field meetings settings. */
export async function saveFieldSettingsAction(
  input: FieldSettingsInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return await withTenantSession(async ({ tenant }) => {
    const gate = await checkPermission('manageFieldSettings');
    if (!gate.ok) return { ok: false, message: 'Only owners and admins can change this.' };
    try {
      await tenantTransaction((tx) =>
        saveFieldSettings(tx, tenant.id, {
          checkinRadiusM: input.checkinRadiusM,
          graceMin: input.graceMin,
          momDueHours: input.momDueHours,
          trackingStart: input.trackingStart,
          trackingEnd: input.trackingEnd,
        }),
      );
    } catch (e) {
      if (e instanceof FieldError) return { ok: false, message: e.message };
      throw e;
    }
    revalidatePath('/dashboard/settings/field');
    return { ok: true };
  });
}
