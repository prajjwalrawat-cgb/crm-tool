'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { canEnterManualActuals } from '@/lib/incentives/access';
import { previewBulkChange, sanitizeBulkChange, type BulkChange } from '@/lib/incentives/bulk';
import { ACCRUAL_BASES, MARGIN_MISS_TREATMENTS } from '@/lib/incentives/engine';
import {
  applyBulkChangeToPlans,
  createPlan,
  recordManualActuals,
  saveTemplate,
  updatePlan,
} from '@/lib/incentives/mutations';
import {
  getPlanRow,
  latestActualsForPlans,
  listPlans,
  rowToTerms,
} from '@/lib/incentives/queries';
import { actualsInput } from '@/lib/incentives/types';
import { recomputeTenant } from '@/lib/inngest/workflows/incentive-actuals-nightly';
import { requireMembership } from '@/lib/membership';
import { requireTenant } from '@/lib/tenant';

export type IncentiveActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { value: T }))
  | { ok: false; message: string; conflict?: boolean };

const decimal = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const optionalDecimal = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => (v === null || String(v).trim() === '' ? null : String(v).trim()));

const termsSchema = z.object({
  fixedCTC: decimal,
  targetVariable: decimal,
  gateRevenueCr: decimal,
  gateIncentiveL: decimal,
  slab1UpperCr: decimal,
  slab1RateL: decimal,
  slab2RateL: decimal,
  stepCr: decimal,
  accrualBasis: z.enum(ACCRUAL_BASES),
  capEnabled: z.boolean(),
  capAmountL: optionalDecimal,
  priorYearCreditPct: decimal,
  netNewCreditPct: decimal,
  marginFloorPct: decimal,
  marginMissTreatment: z.enum(MARGIN_MISS_TREATMENTS),
});

const fiscalYear = z.coerce.number().int().min(2000).max(2100);
const planStatus = z.enum(['draft', 'active', 'closed']);

function firstError(err: z.ZodError): string {
  const flat = z.flattenError(err);
  const field = Object.entries(flat.fieldErrors)[0];
  return flat.formErrors[0] ?? (field ? `${field[0]}: ${(field[1] as string[])[0]}` : 'Invalid input.');
}

function revalidateIncentives(): void {
  revalidatePath('/dashboard/incentives', 'layout');
  revalidatePath('/dashboard/my-incentive');
  revalidatePath('/dashboard/settings/incentives', 'layout');
}

/** Admin gate + tenant context for the admin actions below. */
async function asAdmin<T>(
  fn: (ctx: { tenantId: string; actorId: string }) => Promise<T>,
): Promise<T | { ok: false; message: string }> {
  const gate = await checkPermission('manageIncentives');
  if (!gate.ok) return { ok: false, message: gate.message };
  return await runWithTenantContext(
    { tenantId: gate.tenant.id, userId: gate.membership.userId },
    () => fn({ tenantId: gate.tenant.id, actorId: gate.membership.userId }),
  );
}

/* ------------------------------------------------------------------ *
 * Template                                                            *
 * ------------------------------------------------------------------ */

export async function saveTemplateAction(input: unknown): Promise<IncentiveActionResult> {
  const parsed = z.object({ terms: termsSchema, budgetL: optionalDecimal }).safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  return await asAdmin(async ({ tenantId, actorId }) => {
    const res = await saveTemplate({ tenantId, actorId, terms: parsed.data.terms, budgetL: parsed.data.budgetL });
    if (res.ok) revalidateIncentives();
    return res;
  });
}

/* ------------------------------------------------------------------ *
 * Plans                                                               *
 * ------------------------------------------------------------------ */

export async function createPlanAction(
  input: unknown,
): Promise<IncentiveActionResult<{ planId: string }>> {
  const parsed = z
    .object({
      userId: z.string().min(1).max(200),
      fiscalYear,
      terms: termsSchema,
      status: planStatus.default('draft'),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  return await asAdmin(async ({ tenantId, actorId }) => {
    const res = await createPlan({ tenantId, actorId, ...parsed.data });
    if (res.ok) revalidateIncentives();
    return res;
  });
}

export async function updatePlanAction(
  input: unknown,
): Promise<IncentiveActionResult<{ version: number; changed: boolean }>> {
  const parsed = z
    .object({
      planId: z.string().uuid(),
      expectedVersion: z.number().int().min(1),
      terms: termsSchema.optional(),
      status: planStatus.optional(),
      actualsSource: z.enum(['manual', 'computed']).optional(),
      note: z.string().max(500).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  const { planId, expectedVersion, note, ...patch } = parsed.data;
  // One kind of change per call, so each version row says what it was.
  const kinds = [patch.terms, patch.status, patch.actualsSource].filter((v) => v !== undefined);
  if (kinds.length !== 1) return { ok: false, message: 'Change terms, status or actuals source — one at a time.' };
  return await asAdmin(async ({ tenantId, actorId }) => {
    const res = await updatePlan({ tenantId, actorId, planId, expectedVersion, patch, note: note ?? null });
    if (res.ok) revalidateIncentives();
    return res;
  });
}

/* ------------------------------------------------------------------ *
 * Actuals                                                             *
 * ------------------------------------------------------------------ */

/**
 * Manual actuals: the plan's own SPOC or an admin. Refused while the plan
 * reads computed actuals — a typed figure would be stored but never shown,
 * which is worse than refusing.
 */
export async function recordManualActualsAction(input: unknown): Promise<IncentiveActionResult> {
  const parsed = z
    .object({
      planId: z.string().uuid(),
      asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      priorYearRevenueCr: decimal,
      netNewRevenueCr: decimal,
      blendedMarginPct: decimal,
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  const tenant = await requireTenant();
  const membership = await requireMembership();
  return await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, async () => {
    const plan = await getPlanRow(tenant.id, parsed.data.planId);
    const viewer = { userId: membership.userId, role: membership.role };
    if (!plan || !canEnterManualActuals(viewer, plan)) return { ok: false, message: 'Plan not found.' };
    if (plan.actualsSource !== 'manual') {
      return { ok: false, message: 'This plan reads computed actuals from deal data; switch it to manual first.' };
    }
    if (plan.status === 'closed') return { ok: false, message: 'This plan is closed.' };
    const res = await recordManualActuals({ tenantId: tenant.id, actorId: membership.userId, ...parsed.data });
    if (res.ok) revalidateIncentives();
    return res;
  });
}

/** Admin "Recompute now" — the same path the nightly job runs. */
export async function recomputeActualsAction(input: unknown): Promise<IncentiveActionResult<{ plans: number }>> {
  const parsed = z.object({ planId: z.string().uuid().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  return await asAdmin(async ({ tenantId }) => {
    const plans = await recomputeTenant(tenantId, new Date(), {
      planIds: parsed.data.planId ? [parsed.data.planId] : undefined,
    });
    if (parsed.data.planId && plans === 0) {
      return { ok: false as const, message: 'Only active plans set to computed actuals can be recomputed.' };
    }
    revalidateIncentives();
    return { ok: true as const, value: { plans } };
  });
}

/* ------------------------------------------------------------------ *
 * Bulk                                                                *
 * ------------------------------------------------------------------ */

const bulkSchema = z.object({
  fiscalYear,
  statuses: z.array(planStatus).min(1).default(['active']),
  change: z.record(z.string(), z.unknown()),
});

async function loadBulkScope(tenantId: string, fy: number, statuses: string[]) {
  const plans = (await listPlans(tenantId, fy)).filter((p) => statuses.includes(p.status));
  const actuals = await latestActualsForPlans(tenantId, plans);
  return plans.map((p) => {
    const a = actuals.get(p.id);
    return { planId: p.id, userId: p.userId, version: p.version, terms: rowToTerms(p), actuals: a ? actualsInput(a) : null };
  });
}

function parseChange(raw: Record<string, unknown>): BulkChange | string {
  const change = sanitizeBulkChange(raw) as Record<string, unknown>;
  if (Object.keys(change).length === 0) return 'Pick at least one rule to change.';
  // Re-validate the shape of what's left through the terms schema.
  const shaped = termsSchema.partial().safeParse(change);
  if (!shaped.success) return firstError(shaped.error);
  return shaped.data as BulkChange;
}

export type BulkPreviewResult = ReturnType<typeof previewBulkChange> & {
  planCount: number;
  /** Echoed back on apply, so a plan edited after the preview refuses the apply. */
  planVersions: Record<string, number>;
};

export async function previewBulkChangeAction(input: unknown): Promise<IncentiveActionResult<BulkPreviewResult>> {
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  const change = parseChange(parsed.data.change);
  if (typeof change === 'string') return { ok: false, message: change };
  return await asAdmin(async ({ tenantId }) => {
    const scope = await loadBulkScope(tenantId, parsed.data.fiscalYear, parsed.data.statuses);
    const preview = previewBulkChange(scope, change);
    return {
      ok: true as const,
      value: {
        ...preview,
        planCount: scope.length,
        planVersions: Object.fromEntries(scope.map((p) => [p.planId, p.version])),
      },
    };
  });
}

/**
 * Apply exactly what was previewed. The client sends the plan ids it saw;
 * if the scope has changed since (a plan added, closed, or edited) the
 * apply is refused and the admin re-previews, so nobody confirms one set of
 * numbers and gets another.
 */
export async function applyBulkChangeAction(
  input: unknown,
): Promise<IncentiveActionResult<{ updated: number }>> {
  const parsed = bulkSchema
    .extend({
      planVersions: z.record(z.string().uuid(), z.number().int()),
      note: z.string().max(500).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  const change = parseChange(parsed.data.change);
  if (typeof change === 'string') return { ok: false, message: change };
  return await asAdmin(async ({ tenantId, actorId }) => {
    const scope = await loadBulkScope(tenantId, parsed.data.fiscalYear, parsed.data.statuses);
    const seen = parsed.data.planVersions;
    const drifted =
      scope.length !== Object.keys(seen).length || scope.some((p) => seen[p.planId] !== p.version);
    if (drifted) {
      return { ok: false as const, conflict: true, message: 'Plans changed since the preview. Preview again before applying.' };
    }
    const preview = previewBulkChange(scope, change);
    if (preview.invalidCount > 0) {
      return { ok: false as const, message: `${preview.invalidCount} plan(s) would become invalid — nothing applied.` };
    }
    const res = await applyBulkChangeToPlans({
      tenantId,
      actorId,
      planIds: scope.map((p) => p.planId),
      change,
      note: parsed.data.note ?? null,
    });
    if (res.ok) revalidateIncentives();
    return res;
  });
}
