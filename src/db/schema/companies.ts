import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { contacts } from './contacts';
import { deals } from './deals';
import { geocodeStatus } from './enums';
import { tenants } from './tenants';

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: text('domain'),
    industry: text('industry'),
    /** Clerk user id of the account owner. Null = unassigned. */
    ownerId: text('owner_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Last user to change this company (audit). */
    updatedBy: text('updated_by'),
    /** Admin-defined custom field values, keyed by definition `key`. */
    customFields: jsonb('custom_fields')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
    /**
     * Module 5 (dedup): normalized name for trigram matching (see
     * `normalizeCompanyName`). Kept in sync on create/rename. NULL = pre-backfill.
     */
    normalizedName: text('normalized_name'),
    /**
     * When set, this company was merged INTO the referenced survivor. Merged
     * rows are excluded from all lists/search (like a soft delete) but kept for
     * audit + reversibility.
     */
    mergedIntoId: uuid('merged_into_id'),
    /** True when created despite a surfaced duplicate warning ("Create anyway"). */
    dedupOverride: boolean('dedup_override').notNull().default(false),
    /** Field Meetings (0081): site address; a meeting's address defaults to this. */
    address: text('address'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    geocodeStatus: geocodeStatus('geocode_status'),
    /**
     * Optional per-company check-in radius in metres (50-5000, CHECK in SQL).
     * Overrides the tenant default when set, e.g. for large industrial sites.
     */
    checkinRadiusM: integer('checkin_radius_m'),
  },
  (t) => [
    index('companies_tenant_id_idx').on(t.tenantId),
    index('companies_tenant_name_idx').on(t.tenantId, t.name),
    index('companies_tenant_domain_idx').on(t.tenantId, t.domain),
    index('companies_tenant_owner_idx').on(t.tenantId, t.ownerId),
    index('companies_tenant_deleted_idx').on(t.tenantId, t.deletedAt),
    index('companies_tenant_merged_idx').on(t.tenantId, t.mergedIntoId),
  ],
);

export const companiesRelations = relations(companies, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [companies.tenantId],
    references: [tenants.id],
  }),
  contacts: many(contacts),
  deals: many(deals),
}));

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
