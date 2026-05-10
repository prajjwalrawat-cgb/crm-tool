import { relations, sql } from 'drizzle-orm';
import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * pgvector column type bound at 1536 dims — matches OpenAI's
 * `text-embedding-3-small`. Drizzle's stable API doesn't ship a
 * first-class vector type yet, so we declare it via `customType`. The
 * column is read/written as `number[]` from JS; on the wire, postgres-js
 * accepts the SQL literal form `'[0.1,0.2,...]'`.
 */
export const vector = customType<{
  data: number[];
  driverData: string;
}>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

export const EMBEDDED_ENTITY_TYPES = ['deal', 'company', 'contact'] as const;
export type EmbeddedEntityType = (typeof EMBEDDED_ENTITY_TYPES)[number];

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    /** Plain-text source we embedded — keeps the embedding interpretable for debugging. */
    content: text('content').notNull(),
    embedding: vector('embedding').notNull(),
    /** OpenAI model id used to produce this row. Lets us migrate dims later. */
    model: text('model').notNull(),
    /** SHA-256 of `content`. Lets the embedding workflow skip work when content didn't change. */
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('embeddings_tenant_entity_unique').on(
      t.tenantId,
      t.entityType,
      t.entityId,
    ),
    index('embeddings_tenant_idx').on(t.tenantId),
  ],
);

export const embeddingsRelations = relations(embeddings, ({ one }) => ({
  tenant: one(tenants, {
    fields: [embeddings.tenantId],
    references: [tenants.id],
  }),
}));

export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;

// Touch the import so the schema is exported alongside its peers.
void sql;
