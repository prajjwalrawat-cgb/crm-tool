import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { contacts } from './contacts';
import { deals } from './deals';
import { tenants } from './tenants';

/**
 * Cloud telephony (migration 0073). See docs/telephony-provider-notes.md.
 * `calls.leadId` is a deal id: a lead is a deals row at stage 'lead'.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const TELEPHONY_PROVIDERS = ['exotel', 'knowlarity', 'ozonetel', 'myoperator', 'twilio', 'mock'] as const;
export type TelephonyProviderName = (typeof TELEPHONY_PROVIDERS)[number];

export const CALL_STATUSES = ['initiated', 'ringing', 'answered', 'completed', 'no_answer', 'busy', 'failed', 'missed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_DISPOSITIONS = [
  'connected',
  'not_reachable',
  'callback',
  'interested',
  'not_interested',
  'wrong_number',
  'do_not_call',
  'skipped',
] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export const AGENT_STATUSES = ['available', 'on_break', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** {"tz":"Asia/Kolkata","start":"09:00","end":"21:00"} */
export type CallingHours = { tz: string; start: string; end: string };

export type CallAiSummary = {
  summary: string;
  next_steps: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  objections: string[];
  competitor_mentions: string[];
  suggested_disposition: CallDisposition | 'unclear';
  follow_up_date: string | null;
};

export const telephonyAccounts = pgTable(
  'telephony_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<TelephonyProviderName>().notNull(),
    label: text('label'),
    /** AES-256-GCM (iv ‖ tag ‖ ciphertext), key from env KMS_KEY. Never log. */
    credentialsEncrypted: bytea('credentials_encrypted').notNull(),
    virtualNumbers: text('virtual_numbers').array().notNull().default([]),
    webhookSecret: text('webhook_secret').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('telephony_accounts_tenant_idx').on(t.tenantId, t.isActive)],
);

export const telephonySettings = pgTable('telephony_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  recordCalls: boolean('record_calls').notNull().default(true),
  recordingAnnouncement: boolean('recording_announcement').notNull().default(false),
  consentPolicyVersion: text('consent_policy_version').notNull().default('v1'),
  /** Cloud AI on call audio. OFF by default. */
  aiCallSummary: boolean('ai_call_summary').notNull().default(false),
  /** 0076: speech-to-text on call recordings. OFF by default. */
  transcriptionEnabled: boolean('transcription_enabled').notNull().default(false),
  /** When an admin confirmed that callers are told calls are recorded/transcribed. Required to transcribe. */
  transcriptionConsentAt: timestamp('transcription_consent_at', { withTimezone: true }),
  transcriptionConsentBy: text('transcription_consent_by'),
  /** 'deepgram' | 'sarvam'; null = none chosen = no transcription. */
  transcriptionProvider: text('transcription_provider'),
  callingHours: jsonb('calling_hours')
    .$type<CallingHours>()
    .notNull()
    .default({ tz: 'Asia/Kolkata', start: '09:00', end: '21:00' }),
  enforceDnc: boolean('enforce_dnc').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userPhoneMapping = pgTable(
  'user_phone_mapping',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    agentPhone: text('agent_phone').notNull(),
    agentExt: text('agent_ext'),
    agentStatus: text('agent_status').$type<AgentStatus>().notNull().default('offline'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const TRANSCRIPT_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];
export type TranscriptSpeaker = 'agent' | 'customer' | 'unknown';
export type TranscriptSegment = {
  speaker: TranscriptSpeaker;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  /** Display label when the speaker is 'unknown' (diarised mono audio), e.g. "Speaker 1". */
  label?: string;
};

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => telephonyAccounts.id, { onDelete: 'set null' }),
  provider: text('provider').$type<TelephonyProviderName>().notNull(),
  providerCallId: text('provider_call_id').notNull(),
  direction: text('direction').$type<'outbound' | 'inbound'>().notNull(),
  /** Deal id (leads are deals at stage 'lead'). */
  leadId: uuid('lead_id').references(() => deals.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  userId: text('user_id'),
  fromNumber: text('from_number').notNull(),
  toNumber: text('to_number').notNull(),
  fromNumberNormalized: text('from_number_normalized'),
  toNumberNormalized: text('to_number_normalized'),
  status: text('status').$type<CallStatus>().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSec: integer('duration_sec'),
  talkTimeSec: integer('talk_time_sec'),
  /** INTERNAL — provider URL. Never serialize (see lib/telephony/serialize.ts). */
  recordingUrl: text('recording_url'),
  /** INTERNAL — our storage key. Never serialize. */
  recordingStorageKey: text('recording_storage_key'),
  recordingArchivedAt: timestamp('recording_archived_at', { withTimezone: true }),
  disposition: text('disposition').$type<CallDisposition>(),
  dispositionAt: timestamp('disposition_at', { withTimezone: true }),
  notes: text('notes'),
  callbackAt: timestamp('callback_at', { withTimezone: true }),
  transcript: text('transcript'),
  /** 0076: speaker turns, ordered by startMs. See lib/telephony/transcriber.ts. */
  transcriptSegments: jsonb('transcript_segments').$type<TranscriptSegment[] | null>(),
  transcriptLanguage: text('transcript_language'),
  transcriptProvider: text('transcript_provider'),
  transcriptModel: text('transcript_model'),
  transcriptStatus: text('transcript_status').$type<TranscriptStatus | null>(),
  /** Short, sanitised reason. Never contains audio or transcript text. */
  transcriptError: text('transcript_error'),
  transcriptAttempts: integer('transcript_attempts').notNull().default(0),
  transcriptStartedAt: timestamp('transcript_started_at', { withTimezone: true }),
  transcriptCompletedAt: timestamp('transcript_completed_at', { withTimezone: true }),
  aiSummary: jsonb('ai_summary').$type<CallAiSummary | null>(),
  aiSummaryStatus: text('ai_summary_status').$type<'pending' | 'done' | 'transcript_only' | 'skipped' | 'failed'>(),
  followUpTaskId: uuid('follow_up_task_id'),
  campaignId: uuid('campaign_id'),
  campaignItemId: uuid('campaign_item_id'),
  consentPolicyVersion: text('consent_policy_version'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const dncNumbers = pgTable(
  'dnc_numbers',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    phoneNormalized: text('phone_normalized').notNull(),
    reason: text('reason'),
    addedBy: text('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.phoneNormalized] })],
);

/** Saved lead filter for a campaign. All keys optional; AND-ed. */
export type CampaignLeadFilter = {
  stages?: string[];
  ownerIds?: string[];
  leadSourceIds?: string[];
  createdAfter?: string;
  createdBefore?: string;
  /** Explicit deal ids (e.g. a selection from the deals list). */
  dealIds?: string[];
};

export const callCampaigns = pgTable('call_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mode: text('mode').$type<'preview' | 'progressive'>().notNull(),
  leadFilter: jsonb('lead_filter').$type<CampaignLeadFilter>().notNull().default({}),
  agentIds: text('agent_ids').array().notNull().default([]),
  callingHours: jsonb('calling_hours')
    .$type<CallingHours>()
    .notNull()
    .default({ tz: 'Asia/Kolkata', start: '09:00', end: '21:00' }),
  maxAttempts: integer('max_attempts').notNull().default(3),
  retryGapMinutes: integer('retry_gap_minutes').notNull().default(120),
  status: text('status').$type<'draft' | 'running' | 'paused' | 'completed'>().notNull().default('draft'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const callCampaignItems = pgTable('call_campaign_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id')
    .notNull()
    .references(() => callCampaigns.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id')
    .notNull()
    .references(() => deals.id, { onDelete: 'cascade' }),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  state: text('state').$type<'pending' | 'locked' | 'done' | 'skipped'>().notNull().default('pending'),
  lockedBy: text('locked_by'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastCallId: uuid('last_call_id'),
  lastOutcome: text('last_outcome'),
  skipReason: text('skip_reason'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const callRecordingAccess = pgTable('call_recording_access', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  callId: uuid('call_id')
    .notNull()
    .references(() => calls.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  rangeHeader: text('range_header'),
  accessedAt: timestamp('accessed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TelephonyAccount = typeof telephonyAccounts.$inferSelect;
export type TelephonySettings = typeof telephonySettings.$inferSelect;
export type CallRow = typeof calls.$inferSelect;
export type CallCampaign = typeof callCampaigns.$inferSelect;
export type CallCampaignItem = typeof callCampaignItems.$inferSelect;
