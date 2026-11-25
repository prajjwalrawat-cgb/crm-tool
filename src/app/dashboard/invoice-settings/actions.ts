'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { organizationSettings } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { isOwner, requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requireTenant } from '@/lib/tenant';

const opt = (max: number) => z.string().trim().max(max).optional();

export type InvoiceSettingsResult = { ok: true } | { ok: false; error: string };

/** Resolve the active workspace + assert the caller is its owner. */
async function withOwner<T>(
  fn: (ctx: { tenantId: string; userId: string }) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };
  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }
  return runWithTenantContext({ tenantId, userId }, async () => {
    const membership = await requireMembership().catch(() => null);
    if (!isOwner(membership)) {
      return { ok: false, error: 'Only the owner can edit invoice settings.' };
    }
    return fn({ tenantId, userId });
  });
}

/* ---------- Workspace default terms ---------- */

const termsSchema = z.object({
  paymentTerms: opt(300),
  deliveryTerms: opt(300),
});

export async function saveWorkspaceTermsAction(
  raw: unknown,
): Promise<InvoiceSettingsResult> {
  const parsed = termsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Invalid terms.' };
  const n = (v?: string) => (v && v.trim() ? v.trim() : null);
  return withOwner(async ({ tenantId, userId }) => {
    await getOrgSettings(tenantId); // lazy-seed the row
    await tenantTransaction(async (tx) =>
      tx
        .update(organizationSettings)
        .set({
          invoicePaymentTerms: n(parsed.data.paymentTerms),
          invoiceDeliveryTerms: n(parsed.data.deliveryTerms),
          updatedBy: userId,
        })
        .where(eq(organizationSettings.tenantId, tenantId)),
    );
    revalidatePath('/dashboard/invoice-settings');
    revalidatePath('/dashboard/invoices');
    return { ok: true };
  });
}
