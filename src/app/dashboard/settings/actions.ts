'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  organizationSettings,
  ORG_THEMES,
  ORG_DENSITIES,
  AI_AGGRESSIVENESS,
  INSIGHT_REFRESH_POLICIES,
  REPORT_RANGES,
} from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { DEAL_STAGES } from '@/lib/deals/schema';

/**
 * Per-section UPDATE actions. Each one validates its own slice via
 * Zod, writes through `tenantTransaction` so RLS is honored, stamps
 * `updated_by`, and revalidates the settings layout so the new
 * values render on next navigation.
 *
 * Validation rule: every section is a partial update — only the
 * fields the user touched go through Zod's `.optional()` so unset
 * fields fall back to the DB default.
 *
 * Why per-section: lets the UI form for one section save without
 * dragging the whole row through. Composite "save everything"
 * actions become brittle when sections gain fields.
 */

async function updateSlice<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  builder: (
    parsed: z.infer<T>,
    updatedBy: string,
  ) => Parameters<
    ReturnType<typeof tenantTransaction>['then']
  >[0] extends never
    ? never
    : Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return { ok: false, message: flat.formErrors[0] ?? 'Invalid input' };
  }
  return await withTenantSession(async ({ tenant, userId }) => {
    const patch = builder(parsed.data, userId);
    await tenantTransaction(async (tx) =>
      tx
        .update(organizationSettings)
        .set({ ...patch, updatedBy: userId })
        .where(eq(organizationSettings.tenantId, tenant.id)),
    );
    revalidatePath('/dashboard/settings');
    return { ok: true } as const;
  });
}

/* ----- Appearance ----- */
const appearanceSchema = z.object({
  defaultTheme: z.enum(ORG_THEMES).optional(),
  density: z.enum(ORG_DENSITIES).optional(),
  reducedMotion: z.boolean().optional(),
});

export async function updateAppearanceSettingsAction(input: unknown) {
  return updateSlice(appearanceSchema, input, (parsed) => ({
    ...(parsed.defaultTheme !== undefined && {
      defaultTheme: parsed.defaultTheme,
    }),
    ...(parsed.density !== undefined && { density: parsed.density }),
    ...(parsed.reducedMotion !== undefined && {
      reducedMotion: parsed.reducedMotion,
    }),
  }));
}

/* ----- Notifications ----- */
const notificationsSchema = z.object({
  notifyAssignments: z.boolean().optional(),
  notifyRecommendations: z.boolean().optional(),
  notifyWorkflows: z.boolean().optional(),
  notifyEmailEvents: z.boolean().optional(),
  realtimeEnabled: z.boolean().optional(),
});

export async function updateNotificationSettingsAction(input: unknown) {
  return updateSlice(notificationsSchema, input, (p) => ({
    ...(p.notifyAssignments !== undefined && {
      notifyAssignments: p.notifyAssignments,
    }),
    ...(p.notifyRecommendations !== undefined && {
      notifyRecommendations: p.notifyRecommendations,
    }),
    ...(p.notifyWorkflows !== undefined && {
      notifyWorkflows: p.notifyWorkflows,
    }),
    ...(p.notifyEmailEvents !== undefined && {
      notifyEmailEvents: p.notifyEmailEvents,
    }),
    ...(p.realtimeEnabled !== undefined && {
      realtimeEnabled: p.realtimeEnabled,
    }),
  }));
}

/* ----- Email ----- */
const emailSchema = z.object({
  senderName: z.string().max(200).optional().or(z.literal('')),
  senderEmail: z.string().email().optional().or(z.literal('')),
  defaultSignature: z.string().max(2000).optional().or(z.literal('')),
  replyTo: z.string().email().optional().or(z.literal('')),
  autoBcc: z.string().max(400).optional().or(z.literal('')),
  emailTracking: z.boolean().optional(),
});

export async function updateEmailSettingsAction(input: unknown) {
  return updateSlice(emailSchema, input, (p) => ({
    ...(p.senderName !== undefined && {
      senderName: p.senderName === '' ? null : p.senderName,
    }),
    ...(p.senderEmail !== undefined && {
      senderEmail: p.senderEmail === '' ? null : p.senderEmail,
    }),
    ...(p.defaultSignature !== undefined && {
      defaultSignature: p.defaultSignature === '' ? null : p.defaultSignature,
    }),
    ...(p.replyTo !== undefined && {
      replyTo: p.replyTo === '' ? null : p.replyTo,
    }),
    ...(p.autoBcc !== undefined && {
      autoBcc: p.autoBcc === '' ? null : p.autoBcc,
    }),
    ...(p.emailTracking !== undefined && { emailTracking: p.emailTracking }),
  }));
}

/* ----- Organization ----- */
const organizationSchema = z.object({
  displayName: z.string().max(200).optional().or(z.literal('')),
  locale: z.string().max(20).optional(),
  timezone: z.string().max(50).optional(),
});

export async function updateOrganizationSettingsAction(input: unknown) {
  return updateSlice(organizationSchema, input, (p) => ({
    ...(p.displayName !== undefined && {
      displayName: p.displayName === '' ? null : p.displayName,
    }),
    ...(p.locale !== undefined && { locale: p.locale }),
    ...(p.timezone !== undefined && { timezone: p.timezone }),
  }));
}

/* ----- AI ----- */
const aiSchema = z.object({
  aiEnabled: z.boolean().optional(),
  aiAggressiveness: z.enum(AI_AGGRESSIVENESS).optional(),
  insightRefresh: z.enum(INSIGHT_REFRESH_POLICIES).optional(),
});

export async function updateAiSettingsAction(input: unknown) {
  return updateSlice(aiSchema, input, (p) => ({
    ...(p.aiEnabled !== undefined && { aiEnabled: p.aiEnabled }),
    ...(p.aiAggressiveness !== undefined && {
      aiAggressiveness: p.aiAggressiveness,
    }),
    ...(p.insightRefresh !== undefined && {
      insightRefresh: p.insightRefresh,
    }),
  }));
}

/* ----- Pipeline ----- */
const pipelineSchema = z.object({
  defaultDealStage: z.enum(DEAL_STAGES).optional(),
  defaultReportRange: z.enum(REPORT_RANGES).optional(),
  dashboardMetrics: z.string().max(400).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
});

export async function updatePipelineSettingsAction(input: unknown) {
  return updateSlice(pipelineSchema, input, (p) => ({
    ...(p.defaultDealStage !== undefined && {
      defaultDealStage: p.defaultDealStage,
    }),
    ...(p.defaultReportRange !== undefined && {
      defaultReportRange: p.defaultReportRange,
    }),
    ...(p.dashboardMetrics !== undefined && {
      dashboardMetrics: p.dashboardMetrics,
    }),
    ...(p.fiscalYearStartMonth !== undefined && {
      fiscalYearStartMonth: p.fiscalYearStartMonth,
    }),
  }));
}

/* ----- Currency + Locale ----- */
const currencySchema = z.object({
  defaultCurrency: z.string().min(3).max(3),
  currencyLocale: z.string().min(2).max(20).optional(),
  compactNumbers: z.boolean().optional(),
});

export async function updateCurrencySettingsAction(input: unknown) {
  return updateSlice(currencySchema, input, (p) => ({
    defaultCurrency: p.defaultCurrency.toUpperCase(),
    ...(p.currencyLocale !== undefined && { currencyLocale: p.currencyLocale }),
    ...(p.compactNumbers !== undefined && { compactNumbers: p.compactNumbers }),
  }));
}
