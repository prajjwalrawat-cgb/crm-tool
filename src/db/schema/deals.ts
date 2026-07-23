import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { companies } from './companies';
import { contacts } from './contacts';
import { dealApprovalStatus, dealStage, dealType } from './enums';
import { tenants } from './tenants';

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Free-text company / contact labels typed on the deal form. Used for
     * display when the deal isn't linked to a company/contact record; the
     * list/board show COALESCE(company_name, joined company.name).
     */
    companyNameText: text('company_name'),
    contactNameText: text('contact_name'),
    contactEmailText: text('contact_email'),
    /** Admin-defined custom field values, keyed by definition `key`. */
    customFields: jsonb('custom_fields')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    stage: dealStage('stage').notNull().default('lead'),
    /**
     * Deal classification (New Logo / Renewal / Expansion / Upsell). Optional;
     * used to disambiguate same-named opportunities on the board.
     */
    dealType: dealType('deal_type'),
    // Currency stored as integer minor units (e.g. cents) to avoid float
    // rounding. bigint covers values well past any realistic deal size.
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),
    // Optional unit pricing: amount = unit_price_minor * quantity (when the
    // workspace has deal_unit_pricing_enabled).
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }),
    quantity: integer('quantity'),
    // Optional quoted/offered figure, independent of Amount. NULL = not set.
    offerPriceMinor: bigint('offer_price_minor', { mode: 'number' }),
    // Optional gross margin as basis points (30% = 3000). NULL = not set.
    // A deal's margin value = amountMinor * marginBps / 10000.
    marginBps: integer('margin_bps'),
    /**
     * Manager-approval gate for the Won stage. A deal moved to Won by a
     * sales rep is 'pending' until a manager approves; moved by a
     * manager/admin/owner it is auto-'approved'. Only Won + 'approved'
     * deals count toward sales-target achievement. 'none' for any deal
     * not currently at Won. 'rejected' is a transient audit marker set
     * when a manager rejects (the deal is reopened to Negotiation).
     */
    approvalStatus: dealApprovalStatus('approval_status')
      .notNull()
      .default('none'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Why the deal was lost. Free text; NULL unless stage = 'lost'. */
    lostReason: text('lost_reason'),
    /**
     * Module 6 — Hold parking state. Required when stage = 'hold': a reason code
     * (budget_deferred | champion_left | timing | competitor_evaluation |
     * client_unresponsive | other) + a "revisit on" date. Cleared on leaving
     * Hold. `holdNote` is an optional free-text elaboration.
     */
    holdReason: text('hold_reason'),
    holdRevisitOn: date('hold_revisit_on'),
    holdNote: text('hold_note'),
    /**
     * Human-readable "what has to happen to close" line for pipeline reviews.
     * Distinct from Tasks — a single freeform sentence, not a checklist.
     */
    nextStep: text('next_step'),
    /** Competing vendor on this deal, if any. Freeform. */
    competitor: text('competitor'),
    /** Where the deal came from: Outbound | Referral | Inbound-Website | Partner | Other. */
    source: text('source'),
    // ISO 4217 three-letter code (e.g. "USD", "EUR", "INR"). INR-first
    // deployment default; the app always sends an explicit currency on
    // create/edit (see migration 0046).
    currency: text('currency').notNull().default('INR'),
    expectedCloseDate: date('expected_close_date'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ownerId: text('owner_id'),
    /**
     * Forecast confidence 0–100. Defaults to a stage-derived value
     * via migration 0015; can be overridden per-deal. NULL means the
     * deal pre-dates the migration AND no override was set — treat
     * as the stage default at query time.
     */
    probability: smallint('probability'),
    /**
     * Denormalized current health score (Module 2). The append-only
     * `deal_scores` table is the source of truth + trend history; these two
     * columns are a cache the recompute service keeps in lockstep so the board
     * and the pipeline Score filter are cheap single-column reads. NULL until
     * the deal has been scored at least once.
     */
    healthScore: smallint('health_score'),
    healthBand: text('health_band'),
    /**
     * Forecast category (Module 4): pipeline | best_case | commit | closed_won
     * | omitted. Auto-derived from stage unless `forecastCategoryOverridden` is
     * true, in which case a manager set it explicitly and stage changes leave it
     * alone. NULL = pre-migration; treated as the stage-derived default.
     */
    forecastCategory: text('forecast_category'),
    forecastCategoryOverridden: boolean('forecast_category_overridden')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Last user to change this deal (audit). */
    updatedBy: text('updated_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
  },
  (t) => [
    index('deals_tenant_id_idx').on(t.tenantId),
    index('deals_tenant_stage_idx').on(t.tenantId, t.stage),
    index('deals_tenant_owner_idx').on(t.tenantId, t.ownerId),
    index('deals_tenant_company_idx').on(t.tenantId, t.companyId),
    index('deals_tenant_contact_idx').on(t.tenantId, t.contactId),
    index('deals_tenant_close_date_idx').on(t.tenantId, t.expectedCloseDate),
    index('deals_tenant_deleted_idx').on(t.tenantId, t.deletedAt),
  ],
);

export const dealsRelations = relations(deals, ({ one }) => ({
  tenant: one(tenants, {
    fields: [deals.tenantId],
    references: [tenants.id],
  }),
  company: one(companies, {
    fields: [deals.companyId],
    references: [companies.id],
  }),
  contact: one(contacts, {
    fields: [deals.contactId],
    references: [contacts.id],
  }),
}));

export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
