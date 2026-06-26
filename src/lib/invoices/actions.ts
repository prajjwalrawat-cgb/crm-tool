'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import { isStorageConfigured, uploadInvoiceImage } from '@/lib/storage/supabase';
import { requireTenant } from '@/lib/tenant';

import {
  createInvoice,
  deleteInvoice,
  getInvoiceWithItems,
  updateInvoice,
} from './queries';
import { createInvoiceSchema } from './schema';
import { getInvoiceSettings } from './settings';
import type { InvoicePdfData } from './types';

export type CreateInvoiceResult =
  | { ok: true; id: string; piNumber: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Create a PI. Membership-gated (any member of the active workspace) and
 * RLS-scoped. The payload is re-validated server-side with the same zod
 * schema the form uses; totals are recomputed from the validated input.
 */
export async function createInvoiceAction(
  raw: unknown,
): Promise<CreateInvoiceResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };

  const parsed = createInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      error: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }

  return runWithTenantContext({ tenantId, userId }, async () => {
    try {
      await requireMembership();
    } catch {
      return { ok: false, error: 'You are not a member of this workspace.' };
    }
    const created = await createInvoice(tenantId, userId, parsed.data);
    revalidatePath('/dashboard/invoices');
    return { ok: true, id: created.id, piNumber: created.piNumber };
  });
}

export type InvoiceMutationResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Edit an existing PI. Any member of the workspace may edit; the editor is
 * recorded in `edited_by`. Re-validates with the same schema and recomputes
 * totals server-side.
 */
export async function updateInvoiceAction(
  id: string,
  raw: unknown,
): Promise<InvoiceMutationResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: 'Invalid invoice.' };

  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };

  const parsed = createInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      error: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }

  return runWithTenantContext({ tenantId, userId }, async () => {
    try {
      await requireMembership();
    } catch {
      return { ok: false, error: 'You are not a member of this workspace.' };
    }
    const ok = await updateInvoice(tenantId, userId, id, parsed.data);
    if (!ok) return { ok: false, error: 'Invoice not found.' };
    revalidatePath('/dashboard/invoices');
    return { ok: true };
  });
}

/**
 * Delete a PI. Allowed for the member who created it, or any owner/admin.
 */
export async function deleteInvoiceAction(
  id: string,
): Promise<InvoiceMutationResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: 'Invalid invoice.' };

  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };

  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }

  return runWithTenantContext({ tenantId, userId }, async () => {
    let role: string;
    try {
      role = (await requireMembership()).role;
    } catch {
      return { ok: false, error: 'You are not a member of this workspace.' };
    }

    const data = await getInvoiceWithItems(tenantId, id);
    if (!data) return { ok: false, error: 'Invoice not found.' };

    const isManager = role === 'owner' || role === 'admin';
    const isCreator = data.invoice.createdBy === userId;
    if (!isManager && !isCreator) {
      return { ok: false, error: 'You can only delete invoices you created.' };
    }

    await deleteInvoice(tenantId, id);
    revalidatePath('/dashboard/invoices');
    return { ok: true };
  });
}

/** Fetch a single PI (with items) for client-side PDF generation. */
/**
 * Fetch a logo from storage (server-side, so no browser CORS) and return it
 * as a base64 data URL. Returns null on any failure so the PDF still renders.
 */
async function fetchLogoDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 3 * 1024 * 1024) return null;
    const mime = res.headers.get('content-type') || 'image/png';
    if (!mime.startsWith('image/')) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function getInvoiceForPdfAction(
  id: string,
): Promise<InvoicePdfData | null> {
  if (!z.uuid().safeParse(id).success) return null;

  const { userId } = await auth();
  if (!userId) return null;

  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return null;
  }

  return runWithTenantContext({ tenantId, userId }, async () => {
    try {
      await requireMembership();
    } catch {
      return null;
    }
    const [data, settings] = await Promise.all([
      getInvoiceWithItems(tenantId, id),
      getInvoiceSettings(tenantId),
    ]);
    if (!data) return null;

    const logoDataUrl = settings.logoUrl
      ? await fetchLogoDataUrl(settings.logoUrl)
      : null;

    return {
      id: data.invoice.id,
      createdBy: data.invoice.createdBy,
      piNumber: data.invoice.piNumber,
      piDate: data.invoice.piDate,
      currency: data.invoice.currency,
      status: data.invoice.status,
      logoDataUrl,
      seller: data.invoice.seller,
      buyer: data.invoice.buyer,
      consignee: data.invoice.consignee ?? null,
      paymentTerms: data.invoice.paymentTerms,
      deliveryTerms: data.invoice.deliveryTerms,
      notes: data.invoice.notes,
      taxRate: data.invoice.taxRate,
      subtotalMinor: data.invoice.subtotalMinor,
      taxMinor: data.invoice.taxMinor,
      totalMinor: data.invoice.totalMinor,
      items: data.items.map((it) => ({
        description: it.description,
        hsnSac: it.hsnSac,
        unit: it.unit,
        quantity: it.quantity,
        rateMinor: it.rateMinor,
        amountMinor: it.amountMinor,
        imageUrl: it.imageUrl,
      })),
    } satisfies InvoicePdfData;
  });
}

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB guard (post-compression is far smaller)
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type UploadImageResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Upload a (client-compressed) line-item image to Supabase Storage and
 * return its public URL. Membership-gated; the file is stored under a
 * tenant-scoped path. The form holds the returned URL until the PI is saved.
 */
export async function uploadInvoiceItemImageAction(
  formData: FormData,
): Promise<UploadImageResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };
  if (!isStorageConfigured()) {
    return {
      ok: false,
      error: 'Image storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY.',
    };
  }

  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No image provided.' };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Image is too large.' };
  }
  const ext = IMAGE_EXT[file.type];
  if (!ext) {
    return { ok: false, error: 'Only JPEG, PNG or WebP images are allowed.' };
  }

  return runWithTenantContext({ tenantId, userId }, async () => {
    try {
      await requireMembership();
    } catch {
      return { ok: false, error: 'You are not a member of this workspace.' };
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = await uploadInvoiceImage({
        tenantId,
        bytes,
        contentType: file.type,
        ext,
      });
      return { ok: true, url };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Upload failed.',
      };
    }
  });
}
