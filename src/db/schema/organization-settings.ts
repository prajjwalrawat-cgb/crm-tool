import { relations } from 'drizzle-orm';
import {
  boolean,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * One row per tenant. UPSERTed lazily on first read. Every settings
 * section maps to a typed slice of this table (no jsonb blob) so
 * we keep real defaults, CHECK constraints, and per-section UPDATE
 * paths cleanly indexed.
 *
 * Settings precedence:
 *   - Org defaults live here. Source of truth for currency, locale,
 *     sender, AI policy, notification defaults.
 *   - Per-user preferences (theme picker, etc.) live in next-themes /
 *     Clerk metadata and override the org defaults at render time.
 */
export const ORG_THEMES = ['light', 'dark', 'system'] as const;
export type OrgTheme = (typeof ORG_THEMES)[number];

export const ORG_DENSITIES = ['comfortable', 'compact'] as const;
export type OrgDensity = (typeof ORG_DENSITIES)[number];

export const AI_AGGRESSIVENESS = [
  'conservative',
  'balanced',
  'aggressive',
] as const;
export type AiAggressiveness = (typeof AI_AGGRESSIVENESS)[number];

export const INSIGHT_REFRESH_POLICIES = [
  'on_change',
  'hourly',
  'daily',
  'manual',
] as const;
export type InsightRefreshPolicy = (typeof INSIGHT_REFRESH_POLICIES)[number];

export const REPORT_RANGES = [
  'today',
  'last_7d',
  'last_30d',
  'last_90d',
  'this_quarter',
  'this_year',
  'all_time',
] as const;
export type ReportRange = (typeof REPORT_RANGES)[number];

export const organizationSettings = pgTable('organization_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  displayName: text('display_name'),
  logoUrl: text('logo_url'),

  defaultCurrency: text('default_currency').notNull().default('INR'),
  currencyLocale: text('currency_locale').notNull().default('en-US'),
  locale: text('locale').notNull().default('en-US'),
  timezone: text('timezone').notNull().default('UTC'),
  compactNumbers: boolean('compact_numbers').notNull().default(false),
  fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),

  defaultTheme: text('default_theme').notNull().default('light'),
  density: text('density').notNull().default('comfortable'),
  reducedMotion: boolean('reduced_motion').notNull().default(false),

  /** When true, deals use per-unit pricing (Amount = unit price x quantity). */
  dealUnitPricingEnabled: boolean('deal_unit_pricing_enabled')
    .notNull()
    .default(false),

  defaultDealStage: text('default_deal_stage').notNull().default('lead'),
  defaultReportRange: text('default_report_range').notNull().default('last_30d'),
  dashboardMetrics: text('dashboard_metrics')
    .notNull()
    .default('pipeline,won,wonRecent,activity'),

  senderName: text('sender_name'),
  senderEmail: text('sender_email'),
  defaultSignature: text('default_signature'),
  replyTo: text('reply_to'),
  autoBcc: text('auto_bcc'),
  emailTracking: boolean('email_tracking').notNull().default(false),

  aiEnabled: boolean('ai_enabled').notNull().default(true),
  aiAggressiveness: text('ai_aggressiveness').notNull().default('balanced'),
  insightRefresh: text('insight_refresh').notNull().default('on_change'),

  notifyAssignments: boolean('notify_assignments').notNull().default(true),
  notifyRecommendations: boolean('notify_recommendations').notNull().default(true),
  notifyWorkflows: boolean('notify_workflows').notNull().default(true),
  notifyEmailEvents: boolean('notify_email_events').notNull().default(true),
  realtimeEnabled: boolean('realtime_enabled').notNull().default(true),

  // Invoice (Proforma) seller + bank details — auto-filled on new invoices.
  invoiceSellerName: text('invoice_seller_name'),
  invoiceSellerAddress: text('invoice_seller_address'),
  invoiceGstin: text('invoice_gstin'),
  invoicePan: text('invoice_pan'),
  invoiceCin: text('invoice_cin'),
  invoiceBankName: text('invoice_bank_name'),
  invoiceBankAccount: text('invoice_bank_account'),
  invoiceBankIfsc: text('invoice_bank_ifsc'),
  invoiceBankBranch: text('invoice_bank_branch'),
  invoicePaymentTerms: text('invoice_payment_terms'),
  invoiceDeliveryTerms: text('invoice_delivery_terms'),
  invoiceLogoUrl: text('invoice_logo_url'),

  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const organizationSettingsRelations = relations(
  organizationSettings,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [organizationSettings.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type NewOrganizationSettings = typeof organizationSettings.$inferInsert;
