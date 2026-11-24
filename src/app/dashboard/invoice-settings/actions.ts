'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { organizationSettings } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { INDIAN_STATES } from '@/lib/invoices/india-geo';
import {
  deleteSellerProfile,
  upsertSellerProfile,
} from '@/lib/invoices/seller-profiles';
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

/* ---------- Per-state seller profiles ---------- */

const req = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required`).max(max);

const profileSchema = z.object({
  stateCode: z.string().regex(/^\d{2}$/, 'Pick a state'),
  name: req(200, 'Company name'),
  address: req(600, 'Address'),
  gstin: req(20, 'GSTIN'),
  pan: req(15, 'PAN'),
  cin: opt(30), // optional — not every firm has a CIN
  bankName: req(120, 'Bank name'),
  bankAccount: req(40, 'A/c number'),
  bankIfsc: req(20, 'IFSC'),
  bankBranch: req(120, 'Branch'),
});

export async function saveSellerProfileAction(
  raw: unknown,
): Promise<InvoiceSettingsResult> {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? 'Please fix the form.';
    return { ok: false, error: first };
  }
  const p = parsed.data;
  const state = INDIAN_STATES.find((s) => s.code === p.stateCode);
  if (!state) return { ok: false, error: 'Unknown state.' };
  // Keep the GSTIN consistent with the state (its first 2 chars are the code),
  // so tax (IGST vs CGST/SGST) and the printed state line stay correct.
  if (p.gstin && p.gstin.slice(0, 2) !== p.stateCode) {
    return {
      ok: false,
      error: `GSTIN for ${state.name} must start with ${p.stateCode}.`,
    };
  }
  return withOwner(async ({ tenantId, userId }) => {
    await upsertSellerProfile(
      tenantId,
      {
        stateCode: p.stateCode,
        stateName: state.name,
        name: p.name,
        address: p.address ?? '',
        gstin: p.gstin ?? '',
        pan: p.pan ?? '',
        cin: p.cin ?? '',
        bankName: p.bankName ?? '',
        bankAccount: p.bankAccount ?? '',
        bankIfsc: p.bankIfsc ?? '',
        bankBranch: p.bankBranch ?? '',
      },
      userId,
    );
    revalidatePath('/dashboard/invoice-settings');
    revalidatePath('/dashboard/invoices');
    return { ok: true };
  });
}

export async function deleteSellerProfileAction(
  stateCode: string,
): Promise<InvoiceSettingsResult> {
  if (!/^\d{2}$/.test(stateCode)) return { ok: false, error: 'Invalid state.' };
  return withOwner(async ({ tenantId }) => {
    await deleteSellerProfile(tenantId, stateCode);
    revalidatePath('/dashboard/invoice-settings');
    revalidatePath('/dashboard/invoices');
    return { ok: true };
  });
}
