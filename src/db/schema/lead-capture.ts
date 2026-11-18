import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  type ConditionOp,
  type DistributionStrategy,
  type ImportJobStatus,
  type IngestStatus,
  type LeadSourceType,
  type RuleCondition,
  type Weekday,
} from '../../lib/lead-capture/constants';

import { deals } from './deals';
import { tenants } from './tenants';

/**
 * Lead capture & distribution (migration 0072). A captured lead is a `deals`
 * row at stage 'lead' plus a `contacts` row; these tables hold where it came
 * from, the raw payload, and who it was routed to.
 */

export type LeadSourceConfig = {
  /** Meta lead ads: the Facebook page id the leadgen events come from. */
  page_id?: string;
  /** Meta: restrict to these lead form ids (empty = all). */
  form_ids?: string[];
  /** Meta: long-lived page access token used to fetch lead details. */
  page_token?: string;
};

/** Inbound field name → lead field key (see LEAD_FIELD_KEYS) or `custom.<key>`. */
export type FieldMapping = Record<string, string>;

export const leadSources = pgTable(
  'lead_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<LeadSourceType>().notNull(),
    /** 32 random bytes, hex. Token header or HMAC-SHA256 key. Never log. */
    secretToken: text('secret_token').notNull(),
    fieldMapping: jsonb('field_mapping').$type<FieldMapping>().notNull().default({}),
    defaultRuleId: uuid('default_rule_id'),
    allowedOrigins: text('allowed_origins').array().notNull().default([]),
    /** Per-type settings, e.g. Meta `{ page_id, form_ids, page_token }`. */
    config: jsonb('config').$type<LeadSourceConfig>().notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('lead_sources_tenant_idx').on(t.tenantId)],
);

export type CaptureFormField = {
  key: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox';
  required?: boolean;
  options?: string[];
  validation?: { pattern?: string; maxLength?: number };
};

export const captureForms = pgTable('capture_forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => leadSources.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  fields: jsonb('fields').$type<CaptureFormField[]>().notNull().default([]),
  thankYouMessage: text('thank_you_message'),
  redirectUrl: text('redirect_url'),
  consentText: text('consent_text'),
  theme: jsonb('theme').$type<Record<string, unknown>>().notNull().default({}),
  isPublished: boolean('is_published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});


export const leadIngestEvents = pgTable('lead_ingest_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => leadSources.id, { onDelete: 'cascade' }),
  rawPayload: jsonb('raw_payload').$type<unknown>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status').$type<IngestStatus>().notNull().default('received'),
  error: text('error'),
  dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
  attempts: integer('attempts').notNull().default(0),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});


export type DistributionPool = {
  user_ids: string[];
  weights?: Record<string, number>;
  fixed_owner_id?: string;
};

export const distributionRules = pgTable('distribution_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priority: integer('priority').notNull(),
  conditions: jsonb('conditions').$type<RuleCondition[]>().notNull().default([]),
  strategy: text('strategy').$type<DistributionStrategy>().notNull(),
  pool: jsonb('pool').$type<DistributionPool>().notNull().default({ user_ids: [] }),
  capacityCap: integer('capacity_cap'),
  respectAvailability: boolean('respect_availability').notNull().default(true),
  slaMinutes: integer('sla_minutes').notNull().default(30),
  maxReassignments: integer('max_reassignments').notNull().default(2),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const distributionState = pgTable('distribution_state', {
  ruleId: uuid('rule_id')
    .primaryKey()
    .references(() => distributionRules.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  lastUserId: text('last_user_id'),
  weightsState: jsonb('weights_state').$type<Record<string, number>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per weekday a single ["HH:MM","HH:MM"] window; a missing day = off. */
export type WorkingHours = {
  tz: string;
  days: Partial<Record<Weekday, [string, string]>>;
};

export const userRoutingProfile = pgTable(
  'user_routing_profile',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    isAvailable: boolean('is_available').notNull().default(true),
    workingHours: jsonb('working_hours').$type<WorkingHours | null>(),
    skills: text('skills').array().notNull().default([]),
    regions: text('regions').array().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const leadAssignments = pgTable('lead_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  dealId: uuid('deal_id')
    .notNull()
    .references(() => deals.id, { onDelete: 'cascade' }),
  assignedTo: text('assigned_to').notNull(),
  assignedBy: text('assigned_by').notNull(),
  ruleId: uuid('rule_id').references(() => distributionRules.id, { onDelete: 'set null' }),
  reason: text('reason'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  firstTouchAt: timestamp('first_touch_at', { withTimezone: true }),
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releaseReason: text('release_reason'),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
});


export const leadImportJobs = pgTable(
  'lead_import_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => leadSources.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    fileName: text('file_name'),
    mapping: jsonb('mapping').$type<FieldMapping>().notNull().default({}),
    rows: jsonb('rows').$type<Array<Record<string, string>>>().notNull().default([]),
    status: text('status').$type<ImportJobStatus>().notNull().default('queued'),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    errors: jsonb('errors').$type<Array<{ row: number; error: string }>>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('lead_import_jobs_tenant_idx').on(t.tenantId, t.createdAt)],
);

export type LeadSource = typeof leadSources.$inferSelect;
export type CaptureForm = typeof captureForms.$inferSelect;
export type LeadImportJob = typeof leadImportJobs.$inferSelect;
export type LeadIngestEvent = typeof leadIngestEvents.$inferSelect;
export type DistributionRule = typeof distributionRules.$inferSelect;
export type UserRoutingProfile = typeof userRoutingProfile.$inferSelect;
export type LeadAssignment = typeof leadAssignments.$inferSelect;

export {
  CONDITION_OPS,
  DISTRIBUTION_STRATEGIES,
  IMPORT_JOB_STATUSES,
  INGEST_STATUSES,
  LEAD_SOURCE_TYPES,
  WEEKDAYS,
} from '../../lib/lead-capture/constants';
export type {
  ConditionOp,
  DistributionStrategy,
  ImportJobStatus,
  IngestStatus,
  LeadSourceType,
  RuleCondition,
  Weekday,
};
