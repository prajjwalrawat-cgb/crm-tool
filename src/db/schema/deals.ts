import { relations } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { companies } from './companies';
import { contacts } from './contacts';
import { dealStage } from './enums';
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
    stage: dealStage('stage').notNull().default('lead'),
    // Currency stored as integer minor units (e.g. cents) to avoid float
    // rounding. bigint covers values well past any realistic deal size.
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),
    // ISO 4217 three-letter code (e.g. "USD", "EUR", "INR").
    currency: text('currency').notNull().default('USD'),
    expectedCloseDate: date('expected_close_date'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ownerId: text('owner_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('deals_tenant_id_idx').on(t.tenantId),
    index('deals_tenant_stage_idx').on(t.tenantId, t.stage),
    index('deals_tenant_owner_idx').on(t.tenantId, t.ownerId),
    index('deals_tenant_company_idx').on(t.tenantId, t.companyId),
    index('deals_tenant_contact_idx').on(t.tenantId, t.contactId),
    index('deals_tenant_close_date_idx').on(t.tenantId, t.expectedCloseDate),
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
