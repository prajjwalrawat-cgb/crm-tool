import { relations } from 'drizzle-orm';
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { dealDocumentCategory } from './enums';
import { tenants } from './tenants';

/**
 * Files attached to a deal (proposals, contracts, pricing sheets). The bytes
 * live in Supabase Storage; this table holds the metadata + public URL.
 * `storagePath` is retained so the object can be removed on row delete.
 */
export const dealDocuments = pgTable(
  'deal_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    /** Clerk user id of the uploader. */
    uploadedBy: text('uploaded_by').notNull(),
    fileName: text('file_name').notNull(),
    fileUrl: text('file_url').notNull(),
    /** Object path within the storage bucket; used to delete the object. */
    storagePath: text('storage_path'),
    fileType: text('file_type').notNull().default('application/octet-stream'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    category: dealDocumentCategory('category').notNull().default('other'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('deal_documents_tenant_deal_idx').on(
      t.tenantId,
      t.dealId,
      t.createdAt,
    ),
  ],
);

export const dealDocumentsRelations = relations(dealDocuments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealDocuments.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealDocuments.dealId],
    references: [deals.id],
  }),
}));

export type DealDocument = typeof dealDocuments.$inferSelect;
export type NewDealDocument = typeof dealDocuments.$inferInsert;
