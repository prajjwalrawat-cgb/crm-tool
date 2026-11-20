import 'server-only';

import { and, eq } from 'drizzle-orm';

import { dealOrderProofs, quotes } from '@/db/schema';
import type { DbExecutor } from '@/lib/db-context';

/**
 * Why a deal document can't be deleted from the documents list, or null if
 * it can: it backs the deal's order confirmation, or it is a quote's filed
 * (sent) PDF.
 */
export async function protectedDocumentReason(
  tx: DbExecutor,
  tenantId: string,
  documentId: string,
): Promise<'order_proof' | 'quote' | null> {
  const [proof] = await tx
    .select({ id: dealOrderProofs.id })
    .from(dealOrderProofs)
    .where(and(eq(dealOrderProofs.documentId, documentId), eq(dealOrderProofs.tenantId, tenantId)))
    .limit(1);
  if (proof) return 'order_proof';
  const [quote] = await tx
    .select({ id: quotes.id })
    .from(quotes)
    .where(and(eq(quotes.pdfDocumentId, documentId), eq(quotes.tenantId, tenantId)))
    .limit(1);
  if (quote) return 'quote';
  return null;
}
