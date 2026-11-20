import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { dealDocuments, quotes } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import type { deleteDealDocument, uploadDealDocument } from '@/lib/storage/supabase';

import { QuoteFrozenError, QuoteNotFoundError, QuoteRuleError, getQuote } from './queries';
import { effectiveMilestones } from './template-schema';
import type { QuoteDetail } from './types';

/** Injected so the send flow can be tested without react-pdf or Supabase. */
export type SendDeps = {
  render: (q: QuoteDetail) => Promise<Uint8Array>;
  upload: typeof uploadDealDocument;
  removeUpload: typeof deleteDealDocument;
};

/**
 * Mark a draft quote as sent: render its PDF, file it as a `proposal` deal
 * document and lock the quote. The upload happens outside the transaction;
 * if the transaction fails the uploaded object is removed again.
 */
export async function markQuoteSent(
  tenantId: string,
  userId: string,
  id: string,
  deps: SendDeps,
): Promise<{ documentId: string }> {
  const quote = await getQuote(tenantId, id);
  if (!quote) throw new QuoteNotFoundError();
  if (quote.status !== 'draft') throw new QuoteFrozenError();
  if (quote.items.length === 0) throw new QuoteRuleError('Add at least one line item before sending.');
  for (const s of quote.templateSnapshot.sections) {
    if (s.type !== 'payment_schedule' || !s.enabled) continue;
    const sum = effectiveMilestones(s, quote.content).reduce((a, m) => a + m.percentBps, 0);
    if (sum !== 10_000) {
      throw new QuoteRuleError(`The payment schedule must add up to 100% before sending (now ${sum / 100}%).`);
    }
  }

  const bytes = await deps.render(quote);
  const fileName = `${quote.quoteNumber} Rev ${quote.revision}.pdf`;
  const uploaded = await deps.upload({
    tenantId,
    dealId: quote.dealId,
    bytes,
    contentType: 'application/pdf',
    fileName,
  });

  try {
    return await tenantTransaction(async (tx) => {
      const [cur] = await tx
        .select({ status: quotes.status, updatedAt: quotes.updatedAt })
        .from(quotes)
        .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)))
        .for('update');
      if (!cur) throw new QuoteNotFoundError();
      if (cur.status !== 'draft') throw new QuoteFrozenError();
      // The PDF was rendered from `quote`; an edit since then would file a stale copy.
      if (cur.updatedAt.getTime() !== quote.updatedAt.getTime()) {
        throw new QuoteRuleError('The quote changed while it was being sent. Try again.');
      }

      const [doc] = await tx
        .insert(dealDocuments)
        .values({
          tenantId,
          dealId: quote.dealId,
          uploadedBy: userId,
          fileName,
          fileUrl: uploaded.url,
          storagePath: uploaded.path,
          fileType: 'application/pdf',
          sizeBytes: bytes.byteLength,
          category: 'proposal',
        })
        .returning({ id: dealDocuments.id });
      if (!doc) throw new Error('Failed to record the quote PDF.');

      await tx
        .update(quotes)
        .set({
          status: 'sent',
          sentAt: sql`now()`,
          sentBy: userId,
          pdfDocumentId: doc.id,
          updatedAt: sql`now()`,
          updatedBy: userId,
        })
        .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)));
      return { documentId: doc.id };
    });
  } catch (err) {
    await deps.removeUpload(uploaded.path);
    throw err;
  }
}

export const SEND_FAILED_MESSAGE = 'Could not create the quote PDF. Try again.';

/**
 * What the user sees when markQuoteSent throws. Quote rule errors keep their
 * own message; anything else (render, storage, database) gets a generic one
 * and `unexpected` so the caller logs the cause.
 */
export function sendFailure(err: unknown): { error: string; unexpected: boolean } {
  if (err instanceof QuoteFrozenError || err instanceof QuoteNotFoundError || err instanceof QuoteRuleError) {
    return { error: err.message, unexpected: false };
  }
  return { error: SEND_FAILED_MESSAGE, unexpected: true };
}
