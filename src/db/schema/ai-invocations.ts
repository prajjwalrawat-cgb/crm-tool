import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

export const AI_INVOCATION_KINDS = [
  'embed',
  'chat',
  'search',
  'summary',
] as const;
export type AiInvocationKind = (typeof AI_INVOCATION_KINDS)[number];

export const AI_INVOCATION_STATUSES = ['success', 'error', 'skipped'] as const;
export type AiInvocationStatus = (typeof AI_INVOCATION_STATUSES)[number];

/**
 * Audit log for every AI call. The CRM bills for tokens; this table is
 * the source of truth for "how much did tenant X consume" and "which
 * call started failing at 3am".
 */
export const aiInvocations = pgTable(
  'ai_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Clerk user id, or null for system-initiated calls (cron/workflow). */
    actorUserId: text('actor_user_id'),
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(),
    error: text('error'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('ai_invocations_tenant_created_idx').on(t.tenantId, t.createdAt)],
);

export const aiInvocationsRelations = relations(aiInvocations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [aiInvocations.tenantId],
    references: [tenants.id],
  }),
}));

export type AiInvocation = typeof aiInvocations.$inferSelect;
export type NewAiInvocation = typeof aiInvocations.$inferInsert;
