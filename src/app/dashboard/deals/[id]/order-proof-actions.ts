'use server';

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  dealDocuments,
  dealOrderProofs,
  deals,
  ORDER_PROOF_TYPES,
  type OrderProofAiRead,
} from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { formatCurrency, KNOWN_CURRENCIES, toMinorUnits } from '@/lib/deals/currency';
import { isBlocking, proofWarnings, type ProofWarning } from '@/lib/order-proofs/checks';
import { proofCheckContext } from '@/lib/order-proofs/context';
import { openSealedRead, readOrderProof } from '@/lib/order-proofs/read';
import {
  ORDER_PROOF_FILE_TYPES,
  ORDER_PROOF_MAX_BYTES,
  ORDER_PROOF_ROUNDING_MINOR,
} from '@/lib/order-proofs/shared';
import {
  deleteDealDocument,
  isStorageConfigured,
  uploadDealDocument,
} from '@/lib/storage/supabase';

/**
 * The client's order confirmation on a deal (0071). Two steps, like the card:
 *   1. `readOrderProofAction` — the PO's text is read on this server and the
 *      form is pre-filled. Nothing is stored yet.
 *   2. `submitOrderProofAction` — the rep confirms or corrects the values and
 *      submits; the file and what it says are stored together.
 * A proof is never edited in place; `removeOrderProofAction` takes it off a
 * deal that isn't Won so a corrected one can be submitted.
 */

type Fail = { ok: false; message: string };

function checkFile(file: FormDataEntryValue | null): File | Fail {
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose the PO file.' };
  if (file.size > ORDER_PROOF_MAX_BYTES) return { ok: false, message: 'The file is too large (max 10 MB).' };
  if (!(ORDER_PROOF_FILE_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, message: 'Upload the PO as a PDF or an image (JPG, PNG, WebP).' };
  }
  return file;
}

export type ReadOrderProofResult =
  | { ok: true; read: OrderProofAiRead | null; seal: string | null; notice: string | null }
  | Fail;

/** Step 1: read the document. A scan or an unreadable PDF still lets the rep type it in. */
export async function readOrderProofAction(formData: FormData): Promise<ReadOrderProofResult> {
  const dealId = z.uuid().safeParse(formData.get('dealId'));
  if (!dealId.success) return { ok: false, message: 'Invalid deal.' };
  const file = checkFile(formData.get('file'));
  if (!(file instanceof File)) return file;

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, async () => {
    const [deal] = await tenantTransaction((tx) =>
      tx
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.id, dealId.data), eq(deals.tenantId, tenant.id), isNull(deals.deletedAt)))
        .limit(1),
    );
    if (!deal) return { ok: false, message: 'Deal not found in this tenant.' };

    const result = await readOrderProof({
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type,
    });
    if (!result.ok) return { ok: true, read: null, seal: null, notice: result.message };
    return { ok: true, read: result.read, seal: result.seal, notice: null };
  });
}

const amount = z.coerce
  .number({ message: 'Enter a number' })
  .finite()
  .min(0, 'Must be 0 or more')
  .max(1e13, 'Too large');

const submitSchema = z.object({
  dealId: z.uuid(),
  proofType: z.enum(ORDER_PROOF_TYPES),
  referenceNo: z.string().trim().min(1, 'Enter the PO / order number').max(120),
  issuedOn: z.union([z.literal(''), z.iso.date()]).optional(),
  buyerName: z.string().trim().max(200).optional(),
  currency: z.enum(KNOWN_CURRENCIES),
  subtotal: amount.refine((v) => v > 0, 'Enter the value before tax'),
  tax: amount.default(0),
  // '' first: coerced, an empty total would read as 0.
  total: z.union([z.literal(''), amount]).optional(),
});

export type SubmitOrderProofResult =
  | { ok: true }
  | (Fail & {
      fieldErrors?: Record<string, string[]>;
      /** Checks the rep hasn't confirmed yet; resubmit with them in `acknowledged`. */
      warnings?: ProofWarning[];
    });

/** Step 2: store the file and what it says, as confirmed by the rep. */
export async function submitOrderProofAction(formData: FormData): Promise<SubmitOrderProofResult> {
  if (!isStorageConfigured()) {
    return { ok: false, message: 'Document storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY.' };
  }
  const file = checkFile(formData.get('file'));
  if (!(file instanceof File)) return file;
  const field = (k: string) => {
    const v = formData.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  const parsed = submitSchema.safeParse({
    dealId: field('dealId'),
    proofType: field('proofType'),
    referenceNo: field('referenceNo'),
    issuedOn: field('issuedOn'),
    buyerName: field('buyerName'),
    currency: field('currency'),
    subtotal: field('subtotal'),
    tax: field('tax') || 0,
    total: field('total'),
  });
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Check the PO details.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }
  const d = parsed.data;
  const subtotalMinor = toMinorUnits(d.subtotal, d.currency);
  const taxMinor = toMinorUnits(d.tax, d.currency);
  const enteredTotalMinor =
    d.total === undefined || d.total === '' ? null : toMinorUnits(d.total, d.currency);
  const totalMinor = enteredTotalMinor ?? subtotalMinor + taxMinor;
  if (totalMinor < subtotalMinor) {
    return {
      ok: false,
      message: 'The total can’t be less than the value before tax.',
      fieldErrors: { total: ['Less than the value before tax'] },
    };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Only a reading genuinely made of THIS file is kept as the file's reading.
  const aiRead = openSealedRead(formData.get('seal'), bytes);
  const reference = d.referenceNo.trim();

  return await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, async (): Promise<SubmitOrderProofResult> => {
    const [deal] = await tenantTransaction((tx) =>
      tx
        .select({
          id: deals.id,
          name: deals.name,
          stage: deals.stage,
          amountMinor: deals.amountMinor,
          currency: deals.currency,
          companyId: deals.companyId,
        })
        .from(deals)
        .where(and(eq(deals.id, d.dealId), eq(deals.tenantId, tenant.id), isNull(deals.deletedAt)))
        .limit(1),
    );
    if (!deal) return { ok: false, message: 'Deal not found in this tenant.' };

    if (d.currency !== deal.currency) {
      return {
        ok: false,
        message: `This deal is in ${deal.currency} and the PO is in ${d.currency}. Change the deal's currency to ${d.currency} first, then submit the PO.`,
        fieldErrors: { currency: [`The deal is in ${deal.currency}`] },
      };
    }

    const refMatches = sql`lower(btrim(${dealOrderProofs.referenceNo})) = ${reference.toLowerCase()}`;
    const clash = await tenantTransaction(async (tx) => {
      const existing = await tx
        .select({ subtotalMinor: dealOrderProofs.subtotalMinor, referenceNo: dealOrderProofs.referenceNo })
        .from(dealOrderProofs)
        .where(and(eq(dealOrderProofs.tenantId, tenant.id), eq(dealOrderProofs.dealId, deal.id)));
      if (existing.some((p) => p.referenceNo.trim().toLowerCase() === reference.toLowerCase())) {
        return `PO ${reference} is already attached to this deal.`;
      }
      // A Won deal can be given its missing PO (deals won before POs were
      // required), but never a PO beyond the value it was won at.
      if (deal.stage === 'won') {
        const after = existing.reduce((s, p) => s + p.subtotalMinor, 0) + subtotalMinor;
        if (after > deal.amountMinor + ORDER_PROOF_ROUNDING_MINOR) {
          return `This deal is Won at ${formatCurrency(deal.amountMinor, deal.currency)}; with this PO its POs would come to ${formatCurrency(after, deal.currency)} before tax. Move the deal out of Won to change its value.`;
        }
      }
      // The same client PO counted on two deals would book one order twice.
      if (deal.companyId) {
        const [other] = await tx
          .select({ name: deals.name })
          .from(dealOrderProofs)
          .innerJoin(deals, eq(deals.id, dealOrderProofs.dealId))
          .where(
            and(
              eq(dealOrderProofs.tenantId, tenant.id),
              ne(dealOrderProofs.dealId, deal.id),
              eq(deals.companyId, deal.companyId),
              isNull(deals.deletedAt),
              refMatches,
            ),
          )
          .limit(1);
        if (other) return `PO ${reference} is already attached to "${other.name}" for this client. One PO can back one deal.`;
      }
      return null;
    });
    if (clash) return { ok: false, message: clash, fieldErrors: { referenceNo: [clash] } };

    // Beyond the amount: the PO's buyer, supplier, date, kind and figures.
    // Each warning must be confirmed by the rep; the form resubmits with the
    // codes they confirmed.
    const ctx = await tenantTransaction((tx) => proofCheckContext(tx, tenant.id, deal.id));
    const warnings = ctx
      ? proofWarnings(
          {
            buyerName: d.buyerName?.trim() || null,
            issuedOn: d.issuedOn || null,
            subtotalMinor,
            taxMinor,
            totalMinor: enteredTotalMinor,
            read: aiRead,
          },
          ctx,
        )
      : [];
    // A bad date is never confirmed away: the PO can't be submitted.
    const blocks = warnings.filter(isBlocking);
    if (blocks.length > 0) {
      return {
        ok: false,
        message: blocks.map((w) => w.message).join(' '),
        fieldErrors: { issuedOn: blocks.map((w) => w.message) },
        warnings,
      };
    }
    const acknowledged = new Set(String(formData.get('acknowledged') ?? '').split(','));
    if (warnings.some((w) => !acknowledged.has(w.code))) {
      return {
        ok: false,
        message: 'Check the points below against the PO, then confirm to submit it.',
        warnings,
      };
    }

    let uploaded: { url: string; path: string };
    try {
      uploaded = await uploadDealDocument({
        tenantId: tenant.id,
        dealId: deal.id,
        bytes,
        contentType: file.type,
        fileName: file.name,
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Upload failed.' };
    }

    try {
      await tenantTransaction(async (tx) => {
        const [doc] = await tx
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
            category: 'purchase_order',
          })
          .returning({ id: dealDocuments.id });
        if (!doc) throw new Error('Failed to record the PO file');
        await tx.insert(dealOrderProofs).values({
          tenantId: tenant.id,
          dealId: deal.id,
          documentId: doc.id,
          proofType: d.proofType,
          referenceNo: reference,
          issuedOn: d.issuedOn || null,
          buyerName: d.buyerName?.trim() || null,
          currency: d.currency,
          subtotalMinor,
          taxMinor,
          totalMinor,
          aiRead,
          submittedBy: membership.userId,
        });
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: deal.id,
          action: 'updated',
          metadata: {
            name: deal.name,
            field: 'order_proof',
            op: 'submitted',
            referenceNo: reference,
            subtotalMinor,
            currency: d.currency,
            ...(warnings.length > 0 && {
              confirmedWarnings: warnings.map((w) => ({ code: w.code, message: w.message })),
            }),
            readFromFile: Boolean(aiRead),
          },
        });
      });
    } catch (err) {
      await deleteDealDocument(uploaded.path);
      throw err;
    }

    revalidatePath(`/dashboard/deals/${deal.id}`);
    return { ok: true };
  });
}

const removeSchema = z.object({ id: z.uuid(), dealId: z.uuid() });

/** Take a proof (and its file) off a deal that is not Won. */
export async function removeOrderProofAction(input: unknown): Promise<{ ok: true } | Fail> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, async () => {
    const outcome = await tenantTransaction(async (tx) => {
      const [deal] = await tx
        .select({ id: deals.id, name: deals.name, stage: deals.stage })
        .from(deals)
        .where(and(eq(deals.id, parsed.data.dealId), eq(deals.tenantId, tenant.id), isNull(deals.deletedAt)))
        .limit(1);
      if (!deal) return { ok: false as const, message: 'Deal not found in this tenant.' };
      if (deal.stage === 'won') {
        return {
          ok: false as const,
          message: 'A Won deal keeps the PO it was won on. Move the deal out of Won first to replace it.',
        };
      }
      const [proof] = await tx
        .delete(dealOrderProofs)
        .where(
          and(
            eq(dealOrderProofs.id, parsed.data.id),
            eq(dealOrderProofs.tenantId, tenant.id),
            eq(dealOrderProofs.dealId, deal.id),
          ),
        )
        .returning({ documentId: dealOrderProofs.documentId, referenceNo: dealOrderProofs.referenceNo });
      if (!proof) return { ok: false as const, message: 'That PO is no longer on this deal.' };
      const [doc] = await tx
        .delete(dealDocuments)
        .where(and(eq(dealDocuments.id, proof.documentId), eq(dealDocuments.tenantId, tenant.id)))
        .returning({ storagePath: dealDocuments.storagePath });
      await recordActivity(tx, {
        tenantId: tenant.id,
        actorUserId: membership.userId,
        entityType: 'deal',
        entityId: deal.id,
        action: 'updated',
        metadata: { name: deal.name, field: 'order_proof', op: 'removed', referenceNo: proof.referenceNo },
      });
      return { ok: true as const, storagePath: doc?.storagePath ?? null };
    });
    if (!outcome.ok) return outcome;
    if (outcome.storagePath) await deleteDealDocument(outcome.storagePath);
    revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
    return { ok: true };
  });
}
