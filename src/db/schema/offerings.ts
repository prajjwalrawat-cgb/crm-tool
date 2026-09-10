import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { offeringCategory } from './enums';
import { tenants } from './tenants';

/**
 * The workspace's catalog of what it sells — Products and Services (0066).
 *
 * A catalog table rather than an enum on `deals`: the list is business data
 * that an admin edits from Settings, not a shape that needs a migration to
 * change.
 *
 * `active` is the ONLY retirement mechanism. Rows are never deleted, because
 * closed-won deals reference them and a report that silently loses history is
 * worse than a picker with one stale entry; the FK on `deal_offerings` is
 * `ON DELETE RESTRICT` so that rule holds even against a hand-written DELETE.
 * A deactivated offering keeps rendering on the deals already tagged with it
 * and disappears only from the picker for NEW tags.
 */
export const offerings = pgTable(
  'offerings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: offeringCategory('category').notNull(),
    active: boolean('active').notNull().default(true),
    /** Display order WITHIN a category; ties break by name. Spaced by 10. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Case-insensitive per workspace — two spellings of one product would
    // split its funnel in half. The index is on lower(name); declared here
    // for documentation, created for real in 0066.
    uniqueIndex('offerings_tenant_name_unique').on(t.tenantId, t.name),
    index('offerings_tenant_category_order_idx').on(
      t.tenantId,
      t.category,
      t.sortOrder,
      t.name,
    ),
  ],
);

export const offeringsRelations = relations(offerings, ({ one }) => ({
  tenant: one(tenants, {
    fields: [offerings.tenantId],
    references: [tenants.id],
  }),
}));

export type Offering = typeof offerings.$inferSelect;
export type NewOffering = typeof offerings.$inferInsert;
