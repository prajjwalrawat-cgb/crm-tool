import { relations } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/** Party (bill-to / ship-to). Stored as a JSON snapshot so the PI is
 *  immutable even if the underlying company record later changes. */
export type InvoiceParty = {
  name: string;
  address?: string;
  city?: string;
  locality?: string;
  pincode?: string;
  gstin?: string;
  state?: string;
  stateCode?: string;
};

/** Seller = the issuing workspace; carries extra statutory/bank fields. */
export type InvoiceSeller = InvoiceParty & {
  pan?: string;
  cin?: string;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  bankBranch?: string;
};

export const proformaInvoices = pgTable(
  'proforma_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Human-facing number, unique within a tenant (e.g. PI/25-26/001). */
    piNumber: text('pi_number').notNull(),
    piDate: text('pi_date').notNull(), // ISO yyyy-mm-dd
    status: text('status').notNull().default('draft'), // draft | sent
    currency: text('currency').notNull().default('INR'),

    seller: jsonb('seller').$type<InvoiceSeller>().notNull(),
    buyer: jsonb('buyer').$type<InvoiceParty>().notNull(),
    /** Null → ship-to is the same as bill-to. */
    consignee: jsonb('consignee').$type<InvoiceParty | null>(),

    paymentTerms: text('payment_terms'),
    deliveryTerms: text('delivery_terms'),
    notes: text('notes'),

    /** GST percent applied to the whole invoice (e.g. "18.00"). */
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    // Money is stored in integer minor units (paise) to avoid float drift.
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),

    /** Shipping / freight charge + its own GST rate (taxed separately). */
    shippingMinor: bigint('shipping_minor', { mode: 'number' }).notNull().default(0),
    shippingTaxRate: numeric('shipping_tax_rate', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),

    createdBy: text('created_by'),
    /** Last user to edit this PI (audit). Null until first edit. */
    editedBy: text('edited_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('proforma_invoices_tenant_number_unique').on(t.tenantId, t.piNumber),
    // Keyset/offset listing is "newest first" within a tenant.
    index('proforma_invoices_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export const proformaInvoicesRelations = relations(proformaInvoices, ({ one }) => ({
  tenant: one(tenants, {
    fields: [proformaInvoices.tenantId],
    references: [tenants.id],
  }),
}));

export type ProformaInvoice = typeof proformaInvoices.$inferSelect;
export type NewProformaInvoice = typeof proformaInvoices.$inferInsert;
