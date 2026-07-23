import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Module 5 — one row per human-clicked merge. Stores the FULL loser row snapshot
 * so a merge can be manually reconstructed (un-merged), plus the per-table
 * repoint counts. Append-only; never auto-written.
 */
export const mergeAudit = pgTable(
  'merge_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** 'company' | 'contact'. */
    entityType: text('entity_type').notNull(),
    winnerId: uuid('winner_id').notNull(),
    loserId: uuid('loser_id').notNull(),
    /** Full pre-merge loser row for reversibility. */
    loserSnapshot: jsonb('loser_snapshot')
      .$type<Record<string, unknown>>()
      .notNull(),
    /** { table: rowsRepointed } — what moved to the winner. */
    repointedCounts: jsonb('repointed_counts')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    mergedBy: text('merged_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('merge_audit_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('merge_audit_tenant_winner_idx').on(t.tenantId, t.winnerId),
  ],
);

export const mergeAuditRelations = relations(mergeAudit, ({ one }) => ({
  tenant: one(tenants, {
    fields: [mergeAudit.tenantId],
    references: [tenants.id],
  }),
}));

export type MergeAudit = typeof mergeAudit.$inferSelect;
export type NewMergeAudit = typeof mergeAudit.$inferInsert;
