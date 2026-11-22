import { index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * AI-proposed changes to deals / contacts (0077) and prospects (0079). AI never writes those
 * fields: a row here is applied only when a user accepts it, through the
 * same server actions as a manual edit. See src/lib/ai/suggestions/.
 */

export const SUGGESTION_ENTITY_TYPES = ['deal', 'contact', 'lead', 'prospect'] as const;
export type SuggestionEntityType = (typeof SUGGESTION_ENTITY_TYPES)[number];

export const SUGGESTION_FIELDS = [
  'stage',
  'amount',
  'close_date',
  'next_step',
  'contact_name',
  'contact_email',
  'contact_phone',
  'contact_designation',
  'follow_up_task',
  // Prospect Board enrichment (0079)
  'industry',
  'size_band',
  'product_fit',
  'icp_score',
] as const;
export type SuggestionField = (typeof SUGGESTION_FIELDS)[number];

export const SUGGESTION_SOURCE_TYPES = ['call', 'email', 'enrichment'] as const;
export type SuggestionSourceType = (typeof SUGGESTION_SOURCE_TYPES)[number];

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected', 'superseded', 'stale'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** follow_up_task value. Every other field's value is a JSON scalar (string | number | null). */
export type FollowUpValue = { title: string; due_date: string };
export type SuggestionValue = string | number | null | FollowUpValue;

export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<SuggestionEntityType>().notNull(),
    entityId: uuid('entity_id').notNull(),
    field: text('field').$type<SuggestionField>().notNull(),
    currentValueAtSuggestion: jsonb('current_value_at_suggestion').$type<SuggestionValue>(),
    suggestedValue: jsonb('suggested_value').$type<SuggestionValue>().notNull(),
    evidenceQuote: text('evidence_quote').notNull(),
    sourceType: text('source_type').$type<SuggestionSourceType>().notNull(),
    sourceId: text('source_id').notNull(),
    confidence: real('confidence').notNull(),
    status: text('status').$type<SuggestionStatus>().notNull().default('pending'),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    appliedValue: jsonb('applied_value').$type<SuggestionValue>(),
    liveValueAtDecision: jsonb('live_value_at_decision').$type<SuggestionValue>(),
  },
  (t) => [
    uniqueIndex('ai_suggestions_source_field_unique').on(t.tenantId, t.sourceType, t.sourceId, t.entityType, t.entityId, t.field),
    index('ai_suggestions_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export type AiSuggestion = typeof aiSuggestions.$inferSelect;
export type NewAiSuggestion = typeof aiSuggestions.$inferInsert;

export const aiSuggestionSources = pgTable(
  'ai_suggestion_sources',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').$type<SuggestionSourceType>().notNull(),
    sourceId: text('source_id').notNull(),
    status: text('status').$type<'running' | 'done' | 'failed' | 'skipped'>().notNull().default('running'),
    model: text('model'),
    suggestionsCount: integer('suggestions_count').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.sourceType, t.sourceId] })],
);
