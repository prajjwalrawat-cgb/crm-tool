import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { leadSources } from './lead-capture';
import { tenants } from './tenants';

/**
 * Reporting & manager views (migration 0074). Metric definitions live in
 * `src/lib/reports/metrics.ts`; these tables only hold rollups, spend,
 * saved definitions and digest bookkeeping.
 */

/**
 * Per (tenant, day, owner, source) counters. `day` is the tenant-timezone
 * calendar day. `ownerId` '' = no owner. Uniqueness is an expression index
 * (`report_daily_rollup_key`) on COALESCE(source_id, zero-uuid), so upserts
 * go through raw SQL in `src/lib/reports/manager/rollup.ts`.
 */
export const reportDailyRollup = pgTable(
  'report_daily_rollup',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    ownerId: text('owner_id').notNull(),
    sourceId: uuid('source_id'),
    leadsCreated: integer('leads_created').notNull().default(0),
    leadsAssigned: integer('leads_assigned').notNull().default(0),
    firstTouchCount: integer('first_touch_count').notNull().default(0),
    firstTouchWithinSla: integer('first_touch_within_sla').notNull().default(0),
    medianFirstResponseSec: integer('median_first_response_sec'),
    callsMade: integer('calls_made').notNull().default(0),
    callsConnected: integer('calls_connected').notNull().default(0),
    talkTimeSec: integer('talk_time_sec').notNull().default(0),
    emailsSent: integer('emails_sent').notNull().default(0),
    whatsappSent: integer('whatsapp_sent').notNull().default(0),
    meetingsHeld: integer('meetings_held').notNull().default(0),
    activities: integer('activities').notNull().default(0),
    qualified: integer('qualified').notNull().default(0),
    quotesSent: integer('quotes_sent').notNull().default(0),
    wonCount: integer('won_count').notNull().default(0),
    wonValue: numeric('won_value', { precision: 14, scale: 2 }).notNull().default('0'),
    lostCount: integer('lost_count').notNull().default(0),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('report_daily_rollup_tenant_owner_day_idx').on(t.tenantId, t.ownerId, t.day)],
);

export const BACKFILL_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

export const reportBackfillJobs = pgTable('report_backfill_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  fromDay: date('from_day').notNull(),
  toDay: date('to_day').notNull(),
  cursorDay: date('cursor_day').notNull(),
  daysTotal: integer('days_total').notNull(),
  daysDone: integer('days_done').notNull().default(0),
  status: text('status').$type<BackfillStatus>().notNull().default('pending'),
  error: text('error'),
  startedBy: text('started_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const leadSourceCost = pgTable(
  'lead_source_cost',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => leadSources.id, { onDelete: 'cascade' }),
    /** First of the month. */
    month: date('month').notNull(),
    spend: numeric('spend', { precision: 14, scale: 2 }).notNull(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.sourceId, t.month] })],
);

export type SavedReportDefinition = {
  metrics: string[];
  groupBy?: 'day' | 'owner' | 'source' | null;
  filters?: { ownerId?: string | null; sourceId?: string | null };
  range: string;
  compare?: 'previous' | 'yoy' | null;
};

/**
 * Digest schedule. A `frequency` + local `hour` (and `weekday` for weekly)
 * rather than a raw cron string: the hourly digest cron can evaluate it in the
 * tenant's timezone without a cron parser, and the UI can render it plainly.
 */
export type SavedReportSchedule = {
  frequency: 'daily' | 'weekly';
  /** 0-23, tenant timezone. */
  hour: number;
  /** 0 = Sunday … 6 = Saturday. Weekly only. */
  weekday?: number;
  recipients: string[];
  format: 'email';
};

export const savedReports = pgTable('saved_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').notNull(),
  name: text('name').notNull(),
  definition: jsonb('definition').$type<SavedReportDefinition>().notNull(),
  schedule: jsonb('schedule').$type<SavedReportSchedule | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const reportDigestRuns = pgTable(
  'report_digest_runs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    digestKey: text('digest_key').notNull(),
    recipientUserId: text('recipient_user_id').notNull(),
    period: date('period').notNull(),
    status: text('status').notNull().default('sent'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.digestKey, t.recipientUserId, t.period] })],
);

export const DIGEST_MUTE_KINDS = ['daily', 'weekly', 'all'] as const;
export type DigestMuteKind = (typeof DIGEST_MUTE_KINDS)[number];

export const reportDigestMutes = pgTable(
  'report_digest_mutes',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    digest: text('digest').$type<DigestMuteKind>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId, t.digest] })],
);

export const reportNarrativeCache = pgTable(
  'report_narrative_cache',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cacheKey: text('cache_key').notNull(),
    narrative: jsonb('narrative').$type<unknown>(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.cacheKey] })],
);

export const reportExportAudit = pgTable('report_export_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  report: text('report').notNull(),
  format: text('format').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  rowCount: integer('row_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SavedReport = typeof savedReports.$inferSelect;
export type ReportBackfillJob = typeof reportBackfillJobs.$inferSelect;
