import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { offerings } from './offerings';
import { tenants } from './tenants';

/**
 * Prospect Board (0079): a pre-lead staging area. A prospect is promoted to a
 * deal (lead) once it is ready. See docs/superpowers/specs/2026-11-22-prospect-board-design.md.
 */

export const PROSPECT_STAGES = ['dump', 'researching', 'qualified', 'ready', 'parked'] as const;
export const prospectStage = pgEnum('prospect_stage', PROSPECT_STAGES);
export type ProspectStage = (typeof PROSPECT_STAGES)[number];

export const PROSPECT_SIZE_BANDS = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
export type ProspectSizeBand = (typeof PROSPECT_SIZE_BANDS)[number];

export const PROSPECT_PARKED_REASONS = ['stale', 'manual'] as const;
export type ProspectParkedReason = (typeof PROSPECT_PARKED_REASONS)[number];

export const PROSPECT_VOTE_KINDS = ['know_someone', 'priority'] as const;
export type ProspectVoteKind = (typeof PROSPECT_VOTE_KINDS)[number];

export const PROSPECT_IMPORT_KINDS = ['text', 'csv', 'image'] as const;
export type ProspectImportKind = (typeof PROSPECT_IMPORT_KINDS)[number];

export const PROSPECT_IMPORT_STATUSES = ['parsed', 'confirmed', 'discarded', 'failed'] as const;
export type ProspectImportStatus = (typeof PROSPECT_IMPORT_STATUSES)[number];

export const prospectImports = pgTable('prospect_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  sourceTag: text('source_tag').notNull(),
  inputKind: text('input_kind').$type<ProspectImportKind>().notNull(),
  /** Text input or CSV body. */
  rawText: text('raw_text'),
  /** Image upload path in private storage. */
  rawFilePath: text('raw_file_path'),
  parserModel: text('parser_model'),
  parserOutput: jsonb('parser_output'),
  status: text('status').$type<ProspectImportStatus>().notNull().default('parsed'),
  rowsParsed: integer('rows_parsed').notNull().default(0),
  rowsInserted: integer('rows_inserted').notNull().default(0),
  error: text('error'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

export const prospects = pgTable(
  'prospects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    companyName: text('company_name').notNull(),
    /** normalizeCompanyName(); trigram-indexed. */
    normalizedName: text('normalized_name'),
    /** Lower-cased, no scheme / www. */
    domain: text('domain'),
    contactName: text('contact_name'),
    contactDesignation: text('contact_designation'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    emailNormalized: text('email_normalized'),
    phoneNormalized: text('phone_normalized'),
    industry: text('industry'),
    sizeBand: text('size_band').$type<ProspectSizeBand>(),
    /** Territory: matches deals.lead_city / lead_state. */
    city: text('city'),
    state: text('state'),
    productFitOfferingId: uuid('product_fit_offering_id').references(() => offerings.id, { onDelete: 'set null' }),
    icpScore: smallint('icp_score'),
    clusterTags: text('cluster_tags').array().notNull().default(sql`'{}'::text[]`),
    sourceTag: text('source_tag').notNull(),
    importId: uuid('import_id').references(() => prospectImports.id, { onDelete: 'set null' }),
    notes: text('notes'),
    stage: prospectStage('stage').notNull().default('dump'),
    stageChangedAt: timestamp('stage_changed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null unless parked. */
    parkedReason: text('parked_reason').$type<ProspectParkedReason>(),
    /** User id (text, like deals.owner_id). */
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    promotedDealId: uuid('promoted_deal_id').references(() => deals.id, { onDelete: 'set null' }),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    promotedBy: text('promoted_by'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('prospects_tenant_stage_idx').on(t.tenantId, t.stage).where(sql`${t.deletedAt} IS NULL`),
    index('prospects_tenant_created_idx').on(t.tenantId, t.createdAt).where(sql`${t.deletedAt} IS NULL`),
    index('prospects_tenant_claimed_by_idx').on(t.tenantId, t.claimedBy),
    index('prospects_tenant_source_tag_idx').on(t.tenantId, t.sourceTag),
    index('prospects_tenant_last_activity_idx').on(t.tenantId, t.lastActivityAt),
    index('prospects_normalized_name_trgm_idx').using('gin', t.normalizedName.op('gin_trgm_ops')),
    uniqueIndex('prospects_tenant_promoted_deal_unique')
      .on(t.tenantId, t.promotedDealId)
      .where(sql`${t.promotedDealId} IS NOT NULL`),
  ],
);

export const prospectStageHistory = pgTable(
  'prospect_stage_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    /** Null on the initial insert. */
    fromStage: prospectStage('from_stage'),
    toStage: prospectStage('to_stage').notNull(),
    /** User id, or 'system:auto-park'. */
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('prospect_stage_history_prospect_idx').on(t.tenantId, t.prospectId, t.changedAt),
    index('prospect_stage_history_autopark_idx')
      .on(t.tenantId, t.changedAt)
      .where(sql`${t.changedBy} = 'system:auto-park'`),
  ],
);

export const prospectVotes = pgTable(
  'prospect_votes',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    kind: text('kind').$type<ProspectVoteKind>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.prospectId, t.userId, t.kind] }),
    index('prospect_votes_tenant_idx').on(t.tenantId, t.prospectId),
  ],
);

export type Prospect = typeof prospects.$inferSelect;
export type NewProspect = typeof prospects.$inferInsert;
