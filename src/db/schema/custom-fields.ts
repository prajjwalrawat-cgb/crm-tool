import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  type CustomFieldEntity,
  type CustomFieldType,
} from '@/lib/custom-fields/types';

import { tenants } from './tenants';

// Re-export so `@/db/schema` stays the import site for server code.
export {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  type CustomFieldEntity,
  type CustomFieldType,
};

/**
 * Admin-defined custom field definitions. Values are NOT stored here - they
 * live in a `custom_fields` jsonb column on each entity row, keyed by `key`.
 * Accessed via the base (superuser) connection with an explicit tenant filter
 * (no RLS policy on this config table); permission checks live in the actions.
 */
export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<CustomFieldEntity>().notNull(),
    /** Stable slug used as the jsonb key on the entity row. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    fieldType: text('field_type').$type<CustomFieldType>().notNull(),
    /** Allowed options for `select` fields. */
    options: jsonb('options').$type<string[]>().notNull().default([]),
    required: boolean('required').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('cfd_tenant_entity_key_uniq').on(
      t.tenantId,
      t.entityType,
      t.key,
    ),
  ],
);

export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;
export type NewCustomFieldDefinition = typeof customFieldDefinitions.$inferInsert;
