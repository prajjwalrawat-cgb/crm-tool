import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { dealDocuments, type DealDocument } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

export async function listDealDocuments(
  tenantId: string,
  dealId: string,
): Promise<DealDocument[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(dealDocuments)
      .where(
        and(
          eq(dealDocuments.tenantId, tenantId),
          eq(dealDocuments.dealId, dealId),
        ),
      )
      .orderBy(desc(dealDocuments.createdAt)),
  );
}
