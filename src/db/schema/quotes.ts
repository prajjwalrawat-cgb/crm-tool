import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { dealDocuments } from './deal-documents';
import { deals } from './deals';
import { quoteStatus } from './enums';
import { invoiceSellerProfiles } from './invoice-seller-profiles';
import { offerings } from './offerings';
import type { InvoiceParty, InvoiceSeller } from './proforma-invoices';
import { tenants } from './tenants';

/**
 * Quote builder (0078). Money is integer minor units (paise), rates and
 * discounts are integer basis points. See drizzle/0078_quotes.sql.
 */

/** Per-tenant quote numbering + default validity. One row per tenant. */
export const quoteSettings = pgTable(
  'quote_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    numberPrefix: text('number_prefix').notNull().default('Q'),
    numberSeparator: text('number_separator').notNull().default('/'),
    numberIncludeFy: boolean('number_include_fy').notNull().default(true),
    numberPadding: smallint('number_padding').notNull().default(4),
    defaultValidityDays: integer('default_validity_days').notNull().default(30),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('quote_settings_padding_check', sql`${t.numberPadding} BETWEEN 1 AND 8`),
    check(
      'quote_settings_validity_check',
      sql`${t.defaultValidityDays} BETWEEN 1 AND 365`,
    ),
  ],
);

/** Last issued number per (tenant, fiscal year); '' when the format has no FY. */
export const quoteNumberSequences = pgTable(
  'quote_number_sequences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fiscalYear: text('fiscal_year').notNull(),
    lastValue: integer('last_value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.fiscalYear] })],
);

/** Tenant-built quote format. `body` is `{ theme, sections }`. */
export const quoteTemplates = pgTable(
  'quote_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    body: jsonb('body').$type<unknown>().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('quote_templates_one_default_uq')
      .on(t.tenantId)
      .where(sql`${t.isDefault} AND ${t.archivedAt} IS NULL`),
  ],
);

export type QuoteOverallDiscountType = 'none' | 'amount' | 'percent';

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    quoteNumber: text('quote_number').notNull(),
    revision: integer('revision').notNull().default(1),
    parentQuoteId: uuid('parent_quote_id').references(
      (): AnyPgColumn => quotes.id,
    ),
    status: quoteStatus('status').notNull().default('draft'),
    templateId: uuid('template_id').references(() => quoteTemplates.id, {
      onDelete: 'set null',
    }),
    /** Frozen copy of the template body at quote creation. */
    templateSnapshot: jsonb('template_snapshot').$type<unknown>().notNull(),
    content: jsonb('content')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sellerProfileId: uuid('seller_profile_id').references(
      () => invoiceSellerProfiles.id,
      { onDelete: 'set null' },
    ),
    seller: jsonb('seller').$type<InvoiceSeller>().notNull(),
    buyer: jsonb('buyer').$type<InvoiceParty>().notNull(),
    consignee: jsonb('consignee').$type<InvoiceParty | null>(),
    /** ISO yyyy-mm-dd. */
    quoteDate: date('quote_date', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    currency: text('currency').notNull().default('INR'),
    overallDiscountType: text('overall_discount_type')
      .$type<QuoteOverallDiscountType>()
      .notNull()
      .default('none'),
    /** Minor units when type is 'amount', basis points when 'percent'. */
    overallDiscountValue: bigint('overall_discount_value', { mode: 'number' })
      .notNull()
      .default(0),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' })
      .notNull()
      .default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' })
      .notNull()
      .default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: text('sent_by'),
    pdfDocumentId: uuid('pdf_document_id').references(() => dealDocuments.id, {
      onDelete: 'restrict',
    }),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('quotes_number_revision_uq').on(
      t.tenantId,
      t.quoteNumber,
      t.revision,
    ),
    index('quotes_tenant_deal_idx').on(t.tenantId, t.dealId),
    check(
      'quotes_overall_discount_type_check',
      sql`${t.overallDiscountType} IN ('none', 'amount', 'percent')`,
    ),
  ],
);

export const quoteItems = pgTable(
  'quote_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quotes.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    description: text('description').notNull(),
    hsnSac: text('hsn_sac'),
    unit: text('unit'),
    /** numeric(14,3); drizzle returns a string. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    rateMinor: bigint('rate_minor', { mode: 'number' }).notNull(),
    discountBps: integer('discount_bps').notNull().default(0),
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    allocatedDiscountMinor: bigint('allocated_discount_minor', {
      mode: 'number',
    })
      .notNull()
      .default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    offeringId: uuid('offering_id').references(() => offerings.id, {
      onDelete: 'set null',
    }),
    groupLabel: text('group_label'),
  },
  (t) => [
    index('quote_items_quote_idx').on(t.tenantId, t.quoteId, t.sortOrder),
    check('quote_items_discount_bps_check', sql`${t.discountBps} BETWEEN 0 AND 10000`),
    check('quote_items_tax_rate_bps_check', sql`${t.taxRateBps} BETWEEN 0 AND 4000`),
  ],
);

export type QuoteRow = typeof quotes.$inferSelect;
export type QuoteItemRow = typeof quoteItems.$inferSelect;
