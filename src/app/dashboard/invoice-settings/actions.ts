'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { organizationSettings } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { isOwner, requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import {
  isStorageConfigured,
  uploadInvoiceImage,
} from '@/lib/storage/supabase';
import { requireTenant } from '@/lib/tenant';

const opt = (max: number) => z.string().trim().max(max).optional();

const schema = z.object({
  sellerName: opt(200),
  sellerAddress: opt(600),
  gstin: opt(20),
  pan: opt(15),
  cin: opt(30),
  bankName: opt(120),
  bankAccount: opt(40),
  bankIfsc: opt(20),
  bankBranch: opt(120),
  paymentTerms: opt(300),
  deliveryTerms: opt(300),
  logoUrl: opt(1000),
});

export type InvoiceSettingsResult = { ok: true } | { ok: false; error: string };

/** Save the workspace's invoice seller + bank defaults. Owner only. */
export async function saveInvoiceSettingsAction(
  raw: unknown,
): Promise<InvoiceSettingsResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Please fix the highlighted fields.' };
  }

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

    // Ensure the settings row exists (lazy seed).
    await getOrgSettings(tenantId);

    const n = (v?: string) => (v && v.trim() ? v.trim() : null);
    await tenantTransaction(async (tx) =>
      tx
        .update(organizationSettings)
        .set({
          invoiceSellerName: n(parsed.data.sellerName),
          invoiceSellerAddress: n(parsed.data.sellerAddress),
          invoiceGstin: n(parsed.data.gstin),
          invoicePan: n(parsed.data.pan),
          invoiceCin: n(parsed.data.cin),
          invoiceBankName: n(parsed.data.bankName),
          invoiceBankAccount: n(parsed.data.bankAccount),
          invoiceBankIfsc: n(parsed.data.bankIfsc),
          invoiceBankBranch: n(parsed.data.bankBranch),
          invoicePaymentTerms: n(parsed.data.paymentTerms),
          invoiceDeliveryTerms: n(parsed.data.deliveryTerms),
          invoiceLogoUrl: n(parsed.data.logoUrl),
          updatedBy: userId,
        })
        .where(eq(organizationSettings.tenantId, tenantId)),
    );

    revalidatePath('/dashboard/invoice-settings');
    revalidatePath('/dashboard/invoices');
    return { ok: true };
  });
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const LOGO_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export type LogoUploadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Upload a workspace invoice logo to Supabase Storage. Owner only. */
export async function uploadInvoiceLogoAction(
  formData: FormData,
): Promise<LogoUploadResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };
  if (!isStorageConfigured()) {
    return { ok: false, error: 'Image storage is not configured.' };
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file received.' };
  }
  if (file.size > LOGO_MAX_BYTES) {
    return { ok: false, error: 'Logo must be 2 MB or smaller.' };
  }
  const ext = LOGO_TYPES[file.type];
  if (!ext) {
    return { ok: false, error: 'Use a PNG, JPG, or WebP image.' };
  }

  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }

  return runWithTenantContext({ tenantId, userId }, async () => {
    const membership = await requireMembership().catch(() => null);
    if (!isOwner(membership)) {
      return { ok: false, error: 'Only the owner can change the logo.' };
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = await uploadInvoiceImage({
        tenantId,
        bytes,
        contentType: file.type,
        ext,
      });
      // Persist immediately so there's no "uploaded but forgot to Save" gap.
      await getOrgSettings(tenantId);
      await tenantTransaction(async (tx) =>
        tx
          .update(organizationSettings)
          .set({ invoiceLogoUrl: url, updatedBy: userId })
          .where(eq(organizationSettings.tenantId, tenantId)),
      );
      revalidatePath('/dashboard/invoice-settings');
      revalidatePath('/dashboard/invoices');
      return { ok: true, url };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Upload failed.',
      };
    }
  });
}

/** Remove the workspace invoice logo (persists immediately). Owner only. */
export async function removeInvoiceLogoAction(): Promise<InvoiceSettingsResult> {
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
      return { ok: false, error: 'Only the owner can change the logo.' };
    }
    await getOrgSettings(tenantId);
    await tenantTransaction(async (tx) =>
      tx
        .update(organizationSettings)
        .set({ invoiceLogoUrl: null, updatedBy: userId })
        .where(eq(organizationSettings.tenantId, tenantId)),
    );
    revalidatePath('/dashboard/invoice-settings');
    revalidatePath('/dashboard/invoices');
    return { ok: true };
  });
}
