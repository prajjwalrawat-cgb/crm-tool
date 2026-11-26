import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { companies } from './companies';
import { contacts } from './contacts';
import { deals } from './deals';
import {
  calendarProvider,
  checkinKind,
  geocodeStatus,
  locationProvider,
  locationSource,
  meetingSentiment,
  meetingSource,
  meetingStatus,
  meetingType,
} from './enums';
import { tenants } from './tenants';
import { users } from './users';

/**
 * Field Meetings (0081). See docs/superpowers/specs/2026-11-25-field-meetings-design.md.
 * All tables are tenant tables with RLS; the SQL in drizzle/0081_field_meetings.sql
 * is the source of truth.
 */

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    type: meetingType('type').notNull().default('physical'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    address: text('address'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    geocodeStatus: geocodeStatus('geocode_status').notNull().default('pending'),
    /** Meet / Teams link for virtual meetings. */
    virtualUrl: text('virtual_url'),
    status: meetingStatus('status').notNull().default('planned'),
    source: meetingSource('source').notNull().default('manual'),
    externalCalendarId: text('external_calendar_id'),
    externalEventId: text('external_event_id'),
    externalEtag: text('external_etag'),
    /** Calendar sync bookkeeping (filled by PR 2). */
    syncState: text('sync_state'),
    needsLinking: boolean('needs_linking').notNull().default(false),
    atRiskReasons: text('at_risk_reasons').array().notNull().default([]),
    notes: text('notes'),
    /** Denormalised from meeting_checkins for risk queries. */
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The SQL also has CHECK (end_at > start_at) as meetings_end_after_start_check.
    uniqueIndex('meetings_tenant_source_external_unique').on(
      t.tenantId,
      t.source,
      t.externalEventId,
    ),
    index('meetings_tenant_owner_start_idx').on(t.tenantId, t.ownerId, t.startAt),
    index('meetings_tenant_start_idx').on(t.tenantId, t.startAt),
    index('meetings_tenant_deal_idx').on(t.tenantId, t.dealId),
    // Target of the composite (tenant_id, meeting_id) FKs on the child tables.
    unique('meetings_tenant_id_id_unique').on(t.tenantId, t.id),
  ],
);

/** Every check-in / check-out attempt is logged, accepted or not. */
export const meetingCheckins = pgTable(
  'meeting_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    kind: checkinKind('kind').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    accuracyM: doublePrecision('accuracy_m'),
    /** Null when the site has no coordinates. */
    distanceFromSiteM: doublePrecision('distance_from_site_m'),
    verified: boolean('verified').notNull().default(false),
    accepted: boolean('accepted').notNull().default(true),
    overrideReason: text('override_reason'),
    rejectReason: text('reject_reason'),
    locationSource: locationSource('location_source').notNull().default('browser'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('meeting_checkins_tenant_meeting_captured_idx').on(
      t.tenantId,
      t.meetingId,
      t.capturedAt,
    ),
    // A check-in can never belong to another tenant's meeting.
    foreignKey({
      name: 'meeting_checkins_tenant_meeting_fk',
      columns: [t.tenantId, t.meetingId],
      foreignColumns: [meetings.tenantId, meetings.id],
    }).onDelete('cascade'),
  ],
);

export type MeetingNextStep = {
  text: string;
  dueDate?: string | null;
  [key: string]: unknown;
};

/** One outcome (MOM) per meeting; editing replaces it. */
export const meetingOutcomes = pgTable(
  'meeting_outcomes',
  {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  meetingId: uuid('meeting_id')
    .notNull()
    .unique()
    .references(() => meetings.id, { onDelete: 'cascade' }),
  momText: text('mom_text'),
  audioUrl: text('audio_url'),
  transcript: text('transcript'),
  summary: text('summary'),
  nextSteps: jsonb('next_steps').$type<MeetingNextStep[]>().notNull().default([]),
  sentiment: meetingSentiment('sentiment'),
  dealStageSuggestion: text('deal_stage_suggestion'),
  competitorMentions: text('competitor_mentions').array().notNull().default([]),
  /** none | pending | done | needs_review (filled from PR 3). */
  aiStatus: text('ai_status').notNull().default('none'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'meeting_outcomes_tenant_meeting_fk',
      columns: [t.tenantId, t.meetingId],
      foreignColumns: [meetings.tenantId, meetings.id],
    }).onDelete('cascade'),
  ],
);

/** Per-user Google / Outlook link. Unused until PR 2. Tokens are encrypted (KMS_KEY). */
export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: calendarProvider('provider').notNull(),
    accountEmail: text('account_email'),
    refreshTokenEnc: text('refresh_token_enc'),
    accessTokenEnc: text('access_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    scopes: text('scopes').array().notNull().default([]),
    syncToken: text('sync_token'),
    deltaLink: text('delta_link'),
    channelId: text('channel_id'),
    channelResourceId: text('channel_resource_id'),
    channelExpiry: timestamp('channel_expiry', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    status: text('status').notNull().default('active'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('calendar_connections_tenant_user_provider_unique').on(
      t.tenantId,
      t.userId,
      t.provider,
    ),
  ],
);

/**
 * Native provider pings. In the database this table is PARTITIONED BY RANGE
 * (captured_at) into daily partitions (SQL only, see 0081); Drizzle models it as
 * a normal table. The primary key is (id, captured_at) because a partitioned
 * table's key must include the partition column.
 */
export const locationPings = pgTable(
  'location_pings',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    accuracyM: doublePrecision('accuracy_m'),
    batteryPct: smallint('battery_pct'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.capturedAt] }),
    index('location_pings_tenant_user_captured_idx').on(
      t.tenantId,
      t.userId,
      t.capturedAt,
    ),
  ],
);

/** Who looked at whose location, and why. */
export const locationViewAudit = pgTable(
  'location_view_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    viewerId: text('viewer_id').notNull(),
    subjectUserId: text('subject_user_id').notNull(),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
    context: text('context'),
  },
  (t) => [index('location_view_audit_tenant_viewed_idx').on(t.tenantId, t.viewedAt)],
);

/** One row per tenant; a missing row means defaults. */
export const tenantFieldSettings = pgTable(
  'tenant_field_settings',
  {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  locationProvider: locationProvider('location_provider').notNull().default('none'),
  checkinRadiusM: integer('checkin_radius_m').notNull().default(300),
  noCheckinGraceMin: integer('no_checkin_grace_min').notNull().default(15),
  momDueHours: integer('mom_due_hours').notNull().default(2),
  trackingStart: time('tracking_start').notNull().default('09:00'),
  trackingEnd: time('tracking_end').notNull().default('19:00'),
  trackingIntervalSec: integer('tracking_interval_sec').notNull().default(120),
  checkinOpensBeforeMin: integer('checkin_opens_before_min').notNull().default(120),
  checkinClosesAfterMin: integer('checkin_closes_after_min').notNull().default(240),
  askmiraBaseUrl: text('askmira_base_url'),
  askmiraServiceTokenEnc: text('askmira_service_token_enc'),
  askmiraWebhookSecretEnc: text('askmira_webhook_secret_enc'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  },
  (t) => [
    check('tenant_field_settings_checkin_radius_check', sql`${t.checkinRadiusM} BETWEEN 50 AND 5000`),
    check('tenant_field_settings_grace_check', sql`${t.noCheckinGraceMin} BETWEEN 0 AND 120`),
    check('tenant_field_settings_mom_due_check', sql`${t.momDueHours} BETWEEN 1 AND 72`),
    check('tenant_field_settings_interval_check', sql`${t.trackingIntervalSec} BETWEEN 30 AND 3600`),
    check('tenant_field_settings_tracking_window_check', sql`${t.trackingStart} < ${t.trackingEnd}`),
    check('tenant_field_settings_checkin_opens_check', sql`${t.checkinOpensBeforeMin} BETWEEN 0 AND 1440`),
    check('tenant_field_settings_checkin_closes_check', sql`${t.checkinClosesAfterMin} BETWEEN 0 AND 1440`),
  ],
);

/** Geocoder responses, tenant scoped because client addresses are tenant data. */
export const geocodeCache = pgTable(
  'geocode_cache',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    normalizedAddress: text('normalized_address').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    status: geocodeStatus('status').notNull(),
    provider: text('provider').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.normalizedAddress] })],
);

/**
 * Drive-time responses. Keys are lat/lng rounded to 4 dp; depart_bucket is the
 * departure time rounded to 30 min. Readers ignore rows older than 30 min.
 */
export const driveTimeCache = pgTable(
  'drive_time_cache',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    originKey: text('origin_key').notNull(),
    destKey: text('dest_key').notNull(),
    departBucket: timestamp('depart_bucket', { withTimezone: true }).notNull(),
    minutes: doublePrecision('minutes').notNull(),
    provider: text('provider').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.tenantId, t.originKey, t.destKey, t.departBucket],
    }),
  ],
);

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
export type MeetingCheckin = typeof meetingCheckins.$inferSelect;
export type MeetingOutcome = typeof meetingOutcomes.$inferSelect;
export type TenantFieldSettingsRow = typeof tenantFieldSettings.$inferSelect;
