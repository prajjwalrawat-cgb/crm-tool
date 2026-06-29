import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Per-state seller profiles. A workspace (one company) can have several
 * GST registrations — e.g. Delhi (07) and Karnataka (29) — each with its own
 * GSTIN, address, and bank details. Keyed by (tenant, state_code). The owner
 * fills one profile per state; the PI form lets the user pick the state.
 */
export const invoiceSellerProfiles = pgTable(
  'invoice_seller_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    stateCode: text('state_code').notNull(),
    sellerName: text('seller_name').notNull(),
    address: text('address'),
    gstin: text('gstin'),
    pan: text('pan'),
    cin: text('cin'),
    bankName: text('bank_name'),
    bankAccount: text('bank_account'),
    bankIfsc: text('bank_ifsc'),
    bankBranch: text('bank_branch'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    tenantStateUq: uniqueIndex('invoice_seller_profiles_tenant_state_uq').on(
      t.tenantId,
      t.stateCode,
    ),
  }),
);

export type InvoiceSellerProfile = typeof invoiceSellerProfiles.$inferSelect;
export type NewInvoiceSellerProfile = typeof invoiceSellerProfiles.$inferInsert;
