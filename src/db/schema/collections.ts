import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { proformaInvoices } from './proforma-invoices';
import { tenants } from './tenants';

/*
 * Collections diagnostic (migration 0069). See docs/collections-diagnostic.md.
 * All three tables are tenant-scoped under RLS and every query also filters
 * on tenant_id.
 */

/** The workspace's standard credit period. One row per tenant, created lazily. */
export const collectionSettings = pgTable('collection_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  standardCreditDays: integer('standard_credit_days').notNull().default(30),
  /** Days above standard that count as "materially" above, for the leaderboard flag. */
  materialExcessDays: integer('material_excess_days').notNull().default(15),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Credit period agreed on a deal. A deal with no row is treated as the
 * workspace standard and reported as "assumed".
 *
 * Approval: a period longer than the standard needs a manager/admin's
 * sign-off (`approved_by`). Whether sign-off is NEEDED is evaluated against
 * the standard at read time, so a later change to the standard can't
 * retro-approve anything. Changing the days clears the approval.
 */
export const dealCreditTerms = pgTable(
  'deal_credit_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    agreedCreditDays: integer('agreed_credit_days').notNull(),
    agreedAt: timestamp('agreed_at', { withTimezone: true }).notNull().defaultNow(),
    setBy: text('set_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('deal_credit_terms_deal_unique').on(t.dealId),
    index('deal_credit_terms_tenant_idx').on(t.tenantId),
  ],
);

/**
 * One row per payment received against a proforma invoice. Partial payments
 * are separate rows; "paid" is derived (payments ≥ total), never stored.
 */
export const invoicePayments = pgTable(
  'invoice_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => proformaInvoices.id, { onDelete: 'cascade' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    /** YYYY-MM-DD the money was received. */
    paidOn: date('paid_on').notNull(),
    reference: text('reference'),
    note: text('note'),
    recordedBy: text('recorded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invoice_payments_tenant_invoice_idx').on(t.tenantId, t.invoiceId),
    index('invoice_payments_tenant_paid_on_idx').on(t.tenantId, t.paidOn),
  ],
);

export type CollectionSettingsRow = typeof collectionSettings.$inferSelect;
export type DealCreditTermsRow = typeof dealCreditTerms.$inferSelect;
export type InvoicePaymentRow = typeof invoicePayments.$inferSelect;
