import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { dealDocuments, dealOrderProofs, type DealOrderProof } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

export type DealOrderProofRow = DealOrderProof & {
  fileName: string;
  fileUrl: string;
  fileType: string;
};

/** A deal's order proofs with their files, oldest first. */
export async function listDealOrderProofs(
  tenantId: string,
  dealId: string,
): Promise<DealOrderProofRow[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({
        proof: dealOrderProofs,
        fileName: dealDocuments.fileName,
        fileUrl: dealDocuments.fileUrl,
        fileType: dealDocuments.fileType,
      })
      .from(dealOrderProofs)
      .innerJoin(dealDocuments, eq(dealDocuments.id, dealOrderProofs.documentId))
      .where(and(eq(dealOrderProofs.tenantId, tenantId), eq(dealOrderProofs.dealId, dealId)))
      .orderBy(asc(dealOrderProofs.createdAt))
      .then((rows) =>
        rows.map((r) => ({ ...r.proof, fileName: r.fileName, fileUrl: r.fileUrl, fileType: r.fileType })),
      ),
  );
}
