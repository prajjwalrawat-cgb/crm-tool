import { relations } from 'drizzle-orm';
import { boolean, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Per-workspace (tenant) Phase-2 feature flags. One row per tenant, UPSERTed
 * lazily on first read (see `src/lib/workspace-settings/queries.ts`).
 *
 * Every column defaults OFF so a fresh tenant stays dark until an admin opts
 * in on the Stage Gates settings page. The CGB workspace is flipped ON by the
 * seed script (`scripts/seed-stage-gates.ts`), NOT by the column default, so
 * the "ON for CGB, OFF for everyone else" split lives in seed data rather than
 * being baked into the schema.
 *
 * Kept separate from `organization_settings` on purpose: these are coarse
 * module kill-switches (does this module exist for this tenant at all?),
 * distinct from the fine-grained org preferences (currency, sender, AI policy).
 */
export const workspaceSettings = pgTable('workspace_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** Module 1 — Stage-Gate Enforcement ("Path"). */
  stageGatesEnabled: boolean('stage_gates_enabled').notNull().default(false),
  /** Module 2 — Deal Health Score. */
  dealScoringEnabled: boolean('deal_scoring_enabled').notNull().default(false),
  /** Module 3 — Automatic Email Activity Capture. */
  emailSyncEnabled: boolean('email_sync_enabled').notNull().default(false),
  /** Module 4 — Forecast Rollup. */
  forecastsEnabled: boolean('forecasts_enabled').notNull().default(false),
  /** Module 5 — Duplicate Detection Guardrails. */
  dedupEnabled: boolean('dedup_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const workspaceSettingsRelations = relations(
  workspaceSettings,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [workspaceSettings.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;
export type NewWorkspaceSettings = typeof workspaceSettings.$inferInsert;

/** The five Phase-2 module flags, in declaration order. */
export const WORKSPACE_FEATURE_FLAGS = [
  'stageGatesEnabled',
  'dealScoringEnabled',
  'emailSyncEnabled',
  'forecastsEnabled',
  'dedupEnabled',
] as const;
export type WorkspaceFeatureFlag = (typeof WORKSPACE_FEATURE_FLAGS)[number];
