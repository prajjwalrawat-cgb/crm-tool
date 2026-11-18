/**
 * Lead-capture constants. Dependency-free so client components can import
 * them without pulling Drizzle into the browser bundle. The Drizzle schema
 * (src/db/schema/lead-capture.ts) re-exports these.
 */

export const LEAD_SOURCE_TYPES = [
  'web_form',
  'landing_page',
  'webhook',
  'csv_import',
  'api',
  'manual',
  'meta_ads',
  'google_ads',
  'portal',
] as const;
export type LeadSourceType = (typeof LEAD_SOURCE_TYPES)[number];

export const INGEST_STATUSES = ['received', 'processed', 'duplicate', 'failed'] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export const DISTRIBUTION_STRATEGIES = [
  'round_robin',
  'weighted',
  'least_loaded',
  'skill_match',
  'geo_match',
  'fixed_owner',
] as const;
export type DistributionStrategy = (typeof DISTRIBUTION_STRATEGIES)[number];

export const CONDITION_OPS = ['eq', 'neq', 'in', 'contains', 'gt', 'lt', 'exists'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export type RuleCondition = { field: string; op: ConditionOp; value?: unknown };

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const IMPORT_JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** Lead fields an inbound payload / CSV column can map to. */
export const LEAD_FIELD_KEYS = [
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'company',
  'title',
  'city',
  'state',
  'product_interest',
  'message',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'landing_url',
  'referrer_url',
  'consent',
] as const;
export type LeadFieldKey = (typeof LEAD_FIELD_KEYS)[number];
