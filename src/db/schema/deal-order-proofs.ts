import { relations } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { dealDocuments } from './deal-documents';
import { deals } from './deals';
import { tenants } from './tenants';
import type { OrderProofAiRead, OrderProofType } from '@/lib/order-proofs/types';

export { ORDER_PROOF_TYPES } from '@/lib/order-proofs/types';
export type { OrderProofAiRead, OrderProofType } from '@/lib/order-proofs/types';

/**
 * The client's confirmation of an order (0071): a PO, work order, signed
 * contract … The file is a `deal_documents` row (category 'purchase_order');
 * this row holds what the document says. A deal enters Won only when its
 * proofs' pre-tax value equals the deal value — see src/lib/order-proofs.
 *
 * Rows are never updated (app_user has no UPDATE): a wrong proof is removed
 * and submitted again.
 */
export const dealOrderProofs = pgTable(
  'deal_order_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => dealDocuments.id, { onDelete: 'cascade' }),
    proofType: text('proof_type').$type<OrderProofType>().notNull().default('purchase_order'),
    /** The PO / order number as printed on the document. */
    referenceNo: text('reference_no').notNull(),
    issuedOn: date('issued_on'),
    buyerName: text('buyer_name'),
    currency: text('currency').notNull(),
    /** Value before tax — what the deal value must equal. */
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    aiRead: jsonb('ai_read').$type<OrderProofAiRead | null>(),
    submittedBy: text('submitted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('deal_order_proofs_tenant_deal_idx').on(t.tenantId, t.dealId)],
);

export const dealOrderProofsRelations = relations(dealOrderProofs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealOrderProofs.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealOrderProofs.dealId],
    references: [deals.id],
  }),
  document: one(dealDocuments, {
    fields: [dealOrderProofs.documentId],
    references: [dealDocuments.id],
  }),
}));

export type DealOrderProof = typeof dealOrderProofs.$inferSelect;
export type NewDealOrderProof = typeof dealOrderProofs.$inferInsert;
