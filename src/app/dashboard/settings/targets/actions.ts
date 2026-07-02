'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { salesTargets } from '@/db/schema';
import { db } from '@/db';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { toMinorUnits } from '@/lib/deals/currency';
import { getOrgSettings } from '@/lib/org-settings/queries';

const targetSchema = z.object({
  userId: z.string().min(1, 'Pick a team member').max(120),
  fiscalYear: z.coerce.number().int().min(2000).max(2100),
  revenueTarget: z.coerce
    .number({ message: 'Enter a valid revenue target' })
    .min(0, 'Cannot be negative')
    .max(999_999_999_999),
  marginTarget: z.coerce
    .number({ message: 'Enter a valid margin target' })
    .min(0, 'Cannot be negative')
    .max(999_999_999_999),
});

export type TargetActionResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Upsert one member's annual target (revenue + margin). Admin tier only.
 * Amounts arrive in major units and are stored in minor units in the
 * workspace default currency.
 */
export async function upsertSalesTargetAction(
  input: unknown,
): Promise<TargetActionResult> {
  const gate = await checkPermission('manageTargets');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = targetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: z.flattenError(parsed.error).formErrors[0] ?? 'Invalid input.',
    };
  }

  // getOrgSettings reads the RLS-protected settings table, so it needs a
  // tenant context. The sales_targets upsert itself uses the base connection
  // (non-RLS, scoped by tenant_id explicitly, like org_invitations).
  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const settings = await getOrgSettings(tenant.id);
      const currency = settings.defaultCurrency;
      const revenueTargetMinor = toMinorUnits(
        parsed.data.revenueTarget,
        currency,
      );
      const marginTargetMinor = toMinorUnits(parsed.data.marginTarget, currency);

      await db
        .insert(salesTargets)
        .values({
          tenantId: tenant.id,
          userId: parsed.data.userId,
          fiscalYear: parsed.data.fiscalYear,
          revenueTargetMinor,
          marginTargetMinor,
          currency,
          createdBy: membership.userId,
          updatedBy: membership.userId,
        })
        .onConflictDoUpdate({
          target: [
            salesTargets.tenantId,
            salesTargets.userId,
            salesTargets.fiscalYear,
          ],
          set: {
            revenueTargetMinor,
            marginTargetMinor,
            currency,
            updatedBy: membership.userId,
            updatedAt: new Date(),
          },
        });

      revalidatePath('/dashboard/settings/targets');
      revalidatePath('/dashboard/targets');
      return { ok: true };
    },
  );
}
