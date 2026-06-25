import { relations } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { proformaInvoices } from './proforma-invoices';
import { tenants } from './tenants';

export const proformaInvoiceItems = pgTable(
  'proforma_invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // tenant_id is denormalized onto the line so the same RLS policy
    // (tenant_id = app.tenant_id) protects items directly.
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => proformaInvoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    hsnSac: text('hsn_sac'),
    unit: text('unit').notNull().default('No'),
    quantity: integer('quantity').notNull().default(1),
    rateMinor: bigint('rate_minor', { mode: 'number' }).notNull().default(0),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),
    /** Optional product image — public URL in Supabase Storage. */
    imageUrl: text('image_url'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('proforma_invoice_items_invoice_idx').on(t.invoiceId),
    index('proforma_invoice_items_tenant_idx').on(t.tenantId),
  ],
);

export const proformaInvoiceItemsRelations = relations(
  proformaInvoiceItems,
  ({ one }) => ({
    invoice: one(proformaInvoices, {
      fields: [proformaInvoiceItems.invoiceId],
      references: [proformaInvoices.id],
    }),
  }),
);

export type ProformaInvoiceItem = typeof proformaInvoiceItems.$inferSelect;
export type NewProformaInvoiceItem = typeof proformaInvoiceItems.$inferInsert;
