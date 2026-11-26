'use server';

import { revalidatePath } from 'next/cache';

import { checkPermission, withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { saveFieldSettingsAs, type FieldSettingsPatch } from '@/lib/field/settings';
import { FieldError } from '@/lib/field/types';

export type FieldSettingsInput = {
  checkinRadiusM?: number;
  graceMin?: number;
  momDueHours?: number;
  trackingStart?: string;
  trackingEnd?: string;
  checkinOpensBeforeMin?: number;
  checkinClosesAfterMin?: number;
};

/**
 * Save the workspace's Field meetings settings. Owners and admins may change
 * everything; managers only the check-in window (`saveFieldSettingsAs` rejects
 * any other field from a manager).
 */
export async function saveFieldSettingsAction(
  input: FieldSettingsInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return await withTenantSession(async ({ tenant }) => {
    const gate = await checkPermission('manageFieldCheckinWindow');
    if (!gate.ok) return { ok: false, message: 'Only owners, admins and managers can change this.' };
    const patch: FieldSettingsPatch = {
      checkinRadiusM: input.checkinRadiusM,
      graceMin: input.graceMin,
      momDueHours: input.momDueHours,
      trackingStart: input.trackingStart,
      trackingEnd: input.trackingEnd,
      checkinOpensBeforeMin: input.checkinOpensBeforeMin,
      checkinClosesAfterMin: input.checkinClosesAfterMin,
    };
    for (const k of Object.keys(patch) as Array<keyof FieldSettingsPatch>) if (patch[k] === undefined) delete patch[k];
    try {
      await tenantTransaction((tx) => saveFieldSettingsAs(tx, tenant.id, gate.membership.role, patch));
    } catch (e) {
      if (e instanceof FieldError) return { ok: false, message: e.message };
      throw e;
    }
    revalidatePath('/dashboard/settings/field');
    return { ok: true };
  });
}
