import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { contacts } from './contacts';
import { deals } from './deals';
import { dealContactRole } from './enums';
import { tenants } from './tenants';

/**
 * Stakeholders linked to a deal. A contact can appear on many deals with a
 * per-deal role and an optional "primary" flag. Exactly one primary per deal
 * is enforced by a partial unique index (see 0045).
 */
export const dealContacts = pgTable(
  'deal_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    role: dealContactRole('role').notNull().default('other'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('deal_contacts_deal_contact_unique').on(t.dealId, t.contactId),
    index('deal_contacts_tenant_deal_idx').on(t.tenantId, t.dealId),
    index('deal_contacts_tenant_contact_idx').on(t.tenantId, t.contactId),
  ],
);

export const dealContactsRelations = relations(dealContacts, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealContacts.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealContacts.dealId],
    references: [deals.id],
  }),
  contact: one(contacts, {
    fields: [dealContacts.contactId],
    references: [contacts.id],
  }),
}));

export type DealContact = typeof dealContacts.$inferSelect;
export type NewDealContact = typeof dealContacts.$inferInsert;
