'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { dealDocuments, deals, type DealDocument } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import {
  deleteDealDocument,
  isStorageConfigured,
  uploadDealDocument,
} from '@/lib/storage/supabase';

// Documents are typically larger than the invoice image guard (contracts,
// slide decks). Mirror the invoice action's server-side size check with a
// document-appropriate ceiling.
const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15 MB

// Allow the common sales-document types; block executables/unknowns.
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const CATEGORIES = ['proposal', 'contract', 'pricing', 'other'] as const;

export type UploadDealDocumentResult =
  | { ok: true; document: DealDocument }
  | { ok: false; message: string };

export type DeleteDealDocumentResult =
  | { ok: true }
  | { ok: false; message: string };

export async function uploadDealDocumentAction(
  formData: FormData,
): Promise<UploadDealDocumentResult> {
  if (!isStorageConfigured()) {
    return {
      ok: false,
      message:
        'Document storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY.',
    };
  }

  const dealId = formData.get('dealId');
  const categoryRaw = formData.get('category');
  const file = formData.get('file');

  const dealIdParsed = z.uuid().safeParse(dealId);
  if (!dealIdParsed.success) return { ok: false, message: 'Invalid deal.' };
  const category = CATEGORIES.includes(categoryRaw as (typeof CATEGORIES)[number])
    ? (categoryRaw as (typeof CATEGORIES)[number])
    : 'other';

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'No file provided.' };
  }
  if (file.size > MAX_DOC_BYTES) {
    return { ok: false, message: 'File is too large (max 15 MB).' };
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return {
      ok: false,
      message: 'Unsupported file type (PDF, image, Office doc, or text only).',
    };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const [deal] = await tenantTransaction(async (tx) =>
        tx
          .select({ id: deals.id, name: deals.name })
          .from(deals)
          .where(
            and(
              eq(deals.id, dealIdParsed.data),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .limit(1),
      );
      if (!deal) return { ok: false, message: 'Deal not found in this tenant.' };

      let uploaded: { url: string; path: string };
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        uploaded = await uploadDealDocument({
          tenantId: tenant.id,
          dealId: deal.id,
          bytes,
          contentType: file.type,
          fileName: file.name,
        });
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : 'Upload failed.',
        };
      }

      const document = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(dealDocuments)
          .values({
            tenantId: tenant.id,
            dealId: deal.id,
            uploadedBy: membership.userId,
            fileName: file.name,
            fileUrl: uploaded.url,
            storagePath: uploaded.path,
            fileType: file.type,
            sizeBytes: file.size,
            category,
          })
          .returning();
        if (!row) throw new Error('Failed to record document');

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: deal.id,
          action: 'updated',
          metadata: {
            name: deal.name,
            field: 'document',
            op: 'uploaded',
            fileName: file.name,
          },
        });
        return row;
      });

      revalidatePath(`/dashboard/deals/${deal.id}`);
      return { ok: true, document };
    },
  );
}

const deleteSchema = z.object({ id: z.uuid(), dealId: z.uuid() });

export async function deleteDealDocumentAction(
  input: unknown,
): Promise<DeleteDealDocumentResult> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const removed = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .delete(dealDocuments)
          .where(
            and(
              eq(dealDocuments.id, parsed.data.id),
              eq(dealDocuments.tenantId, tenant.id),
              eq(dealDocuments.dealId, parsed.data.dealId),
            ),
          )
          .returning({ storagePath: dealDocuments.storagePath });
        return row ?? null;
      });

      if (removed?.storagePath) {
        await deleteDealDocument(removed.storagePath);
      }

      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      return { ok: true };
    },
  );
}
