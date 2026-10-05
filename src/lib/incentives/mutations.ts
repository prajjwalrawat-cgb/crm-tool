import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  incentiveActuals,
  incentivePlans,
  incentivePlanTemplates,
  incentivePlanVersions,
  type IncentivePlanRow,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { applyBulkChange, type BulkChange } from './bulk';
import { validateActuals, validatePlanTerms } from './engine';
import { rowToTerms, termsToColumns } from './queries';
import type { PlanStatus } from './rollup';
import { canonicalDecimal, diffTerms, toStoredTerms, type StoredTerms } from './terms';
import type { ActualsSource } from './types';

type Tx = Parameters<Parameters<typeof tenantTransaction>[0]>[0];

export type MutationResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { value: T }))
  | { ok: false; message: string; conflict?: boolean };

function snapshotOf(row: Pick<IncentivePlanRow, 'status' | 'actualsSource'>, terms: StoredTerms) {
  return { ...terms, status: row.status, actualsSource: row.actualsSource };
}

async function appendVersion(
  tx: Tx,
  input: {
    tenantId: string;
    planId: string;
    version: number;
    action: string;
    actorId: string;
    changes: Record<string, { from: unknown; to: unknown }>;
    snapshot: Record<string, unknown>;
    note?: string | null;
  },
): Promise<void> {
  await tx.insert(incentivePlanVersions).values({
    tenantId: input.tenantId,
    planId: input.planId,
    version: input.version,
    action: input.action,
    changedBy: input.actorId,
    changes: input.changes,
    snapshot: input.snapshot,
    note: input.note ?? null,
  });
}

/* ------------------------------------------------------------------ *
 * Create                                                              *
 * ------------------------------------------------------------------ */

export async function createPlan(input: {
  tenantId: string;
  actorId: string;
  userId: string;
  fiscalYear: number;
  terms: StoredTerms;
  status?: PlanStatus;
  actualsSource?: ActualsSource;
}): Promise<MutationResult<{ planId: string }>> {
  const terms = toStoredTerms(input.terms);
  const issues = validatePlanTerms(terms);
  if (issues.length > 0) return { ok: false, message: issues.join('; ') };
  const status = input.status ?? 'draft';
  const actualsSource = input.actualsSource ?? 'manual';

  return await tenantTransaction(async (tx) => {
    const [row] = await tx
      .insert(incentivePlans)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        fiscalYear: input.fiscalYear,
        ...termsToColumns(terms),
        status,
        actualsSource,
        version: 1,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      .onConflictDoNothing({
        target: [incentivePlans.tenantId, incentivePlans.userId, incentivePlans.fiscalYear],
      })
      .returning();
    if (!row) {
      return { ok: false, message: 'This resource already has a plan for that fiscal year — edit it instead.', conflict: true };
    }
    await appendVersion(tx, {
      tenantId: input.tenantId,
      planId: row.id,
      version: 1,
      action: 'created',
      actorId: input.actorId,
      changes: {},
      snapshot: snapshotOf(row, terms),
    });
    return { ok: true, value: { planId: row.id } };
  });
}

/* ------------------------------------------------------------------ *
 * Versioned update                                                    *
 * ------------------------------------------------------------------ */

type PlanPatch = {
  terms?: StoredTerms;
  status?: PlanStatus;
  actualsSource?: ActualsSource;
};

/**
 * Apply a change to one plan inside an open transaction. Refuses unless the
 * row is still at `expectedVersion` (when given) — so two admins editing the
 * same plan can't silently overwrite each other — and writes the version row
 * in the same transaction as the update.
 */
async function updatePlanInTx(
  tx: Tx,
  input: {
    tenantId: string;
    actorId: string;
    planId: string;
    expectedVersion: number | null;
    patch: PlanPatch;
    action: string;
    note?: string | null;
  },
): Promise<MutationResult<{ version: number; changed: boolean }>> {
  const [current] = await tx
    .select()
    .from(incentivePlans)
    .where(and(eq(incentivePlans.tenantId, input.tenantId), eq(incentivePlans.id, input.planId)))
    .for('update')
    .limit(1);
  if (!current) return { ok: false, message: 'Plan not found.' };
  if (input.expectedVersion != null && current.version !== input.expectedVersion) {
    return {
      ok: false,
      conflict: true,
      message: `This plan was changed by someone else (now version ${current.version}, you loaded ${input.expectedVersion}). Reload to see their change before saving yours.`,
    };
  }

  const beforeTerms = rowToTerms(current);
  const afterTerms = input.patch.terms ? toStoredTerms(input.patch.terms) : beforeTerms;
  const issues = validatePlanTerms(afterTerms);
  if (issues.length > 0) return { ok: false, message: issues.join('; ') };

  const changes: Record<string, { from: unknown; to: unknown }> = { ...diffTerms(beforeTerms, afterTerms) };
  const status = input.patch.status ?? (current.status as PlanStatus);
  const actualsSource = input.patch.actualsSource ?? (current.actualsSource as ActualsSource);
  if (status !== current.status) changes.status = { from: current.status, to: status };
  if (actualsSource !== current.actualsSource) {
    changes.actualsSource = { from: current.actualsSource, to: actualsSource };
  }
  if (Object.keys(changes).length === 0) {
    return { ok: true, value: { version: current.version, changed: false } };
  }

  const version = current.version + 1;
  await tx
    .update(incentivePlans)
    .set({
      ...termsToColumns(afterTerms),
      status,
      actualsSource,
      version,
      updatedBy: input.actorId,
      updatedAt: new Date(),
    })
    .where(and(eq(incentivePlans.id, current.id), eq(incentivePlans.version, current.version)));
  await appendVersion(tx, {
    tenantId: input.tenantId,
    planId: current.id,
    version,
    action: input.action,
    actorId: input.actorId,
    changes,
    snapshot: { ...afterTerms, status, actualsSource },
    note: input.note,
  });
  return { ok: true, value: { version, changed: true } };
}

export async function updatePlan(input: {
  tenantId: string;
  actorId: string;
  planId: string;
  expectedVersion: number;
  patch: PlanPatch;
  note?: string | null;
}): Promise<MutationResult<{ version: number; changed: boolean }>> {
  const action =
    input.patch.terms
      ? 'updated'
      : input.patch.actualsSource
        ? 'actuals_source_changed'
        : 'status_changed';
  return await tenantTransaction((tx) => updatePlanInTx(tx, { ...input, action }));
}

/**
 * Apply a rule change to many plans in one transaction — all land or none.
 * Each plan still gets its own version row (action 'bulk_updated'), so a
 * resource's history shows the bulk change like any other edit.
 */
export async function applyBulkChangeToPlans(input: {
  tenantId: string;
  actorId: string;
  planIds: string[];
  change: BulkChange;
  note?: string | null;
}): Promise<MutationResult<{ updated: number }>> {
  if (input.planIds.length === 0) return { ok: false, message: 'No plans selected.' };
  return await tenantTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(incentivePlans)
      .where(and(eq(incentivePlans.tenantId, input.tenantId), inArray(incentivePlans.id, input.planIds)));
    if (rows.length !== input.planIds.length) {
      return { ok: false, message: 'Some selected plans no longer exist. Reload and try again.' } as const;
    }
    let updated = 0;
    for (const row of rows) {
      const next = toStoredTerms(applyBulkChange(rowToTerms(row), input.change));
      const res = await updatePlanInTx(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        planId: row.id,
        expectedVersion: null,
        patch: { terms: next },
        action: 'bulk_updated',
        note: input.note,
      });
      if (!res.ok) {
        // Abort the whole batch: a half-applied rate change is worse than none.
        throw new BulkAbort(`Plan for ${row.userId}: ${res.message}`);
      }
      if (res.value.changed) updated++;
    }
    return { ok: true, value: { updated } } as const;
  }).catch((e: unknown) => {
    if (e instanceof BulkAbort) return { ok: false as const, message: e.message };
    throw e;
  });
}

class BulkAbort extends Error {}

/* ------------------------------------------------------------------ *
 * Template                                                            *
 * ------------------------------------------------------------------ */

export async function saveTemplate(input: {
  tenantId: string;
  actorId: string;
  terms: StoredTerms;
  budgetL: string | null;
}): Promise<MutationResult> {
  const terms = toStoredTerms(input.terms);
  const issues = validatePlanTerms(terms);
  if (issues.length > 0) return { ok: false, message: issues.join('; ') };
  const budget = input.budgetL ? canonicalDecimal(input.budgetL) : null;
  if (budget && Number(budget) < 0) return { ok: false, message: 'Budget cannot be negative' };
  await tenantTransaction((tx) =>
    tx
      .insert(incentivePlanTemplates)
      .values({ tenantId: input.tenantId, ...termsToColumns(terms), budgetL: budget, updatedBy: input.actorId })
      .onConflictDoUpdate({
        target: incentivePlanTemplates.tenantId,
        set: { ...termsToColumns(terms), budgetL: budget, updatedBy: input.actorId, updatedAt: new Date() },
      }),
  );
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Manual actuals                                                      *
 * ------------------------------------------------------------------ */

/** Always appends — a manual entry never replaces an earlier one. */
export async function recordManualActuals(input: {
  tenantId: string;
  actorId: string;
  planId: string;
  asOfDate: string;
  priorYearRevenueCr: string;
  netNewRevenueCr: string;
  blendedMarginPct: string;
}): Promise<MutationResult> {
  const issues = validateActuals(input);
  if (issues.length > 0) return { ok: false, message: issues.join('; ') };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate)) return { ok: false, message: 'Invalid as-of date' };
  await tenantTransaction((tx) =>
    tx.insert(incentiveActuals).values({
      tenantId: input.tenantId,
      planId: input.planId,
      asOfDate: input.asOfDate,
      priorYearRevenueCr: canonicalDecimal(input.priorYearRevenueCr)!,
      netNewRevenueCr: canonicalDecimal(input.netNewRevenueCr)!,
      blendedMarginPct: canonicalDecimal(input.blendedMarginPct)!,
      source: 'manual',
      enteredBy: input.actorId,
    }),
  );
  return { ok: true };
}

/**
 * Computed actuals: one row per plan per day. A same-day re-run replaces the
 * figure (it is a full recomputation, so this can't double-count); other
 * days are untouched history.
 */
export async function upsertComputedActuals(input: {
  tenantId: string;
  planId: string;
  asOfDate: string;
  priorYearRevenueCr: string;
  netNewRevenueCr: string;
  blendedMarginPct: string;
  details: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await tenantTransaction((tx) =>
    tx
      .insert(incentiveActuals)
      .values({
        tenantId: input.tenantId,
        planId: input.planId,
        asOfDate: input.asOfDate,
        priorYearRevenueCr: input.priorYearRevenueCr,
        netNewRevenueCr: input.netNewRevenueCr,
        blendedMarginPct: input.blendedMarginPct,
        source: 'computed',
        computedAt: now,
        details: input.details,
      })
      .onConflictDoUpdate({
        target: [incentiveActuals.planId, incentiveActuals.asOfDate],
        targetWhere: sql`${incentiveActuals.source} = 'computed'`,
        set: {
          priorYearRevenueCr: input.priorYearRevenueCr,
          netNewRevenueCr: input.netNewRevenueCr,
          blendedMarginPct: input.blendedMarginPct,
          computedAt: now,
          details: input.details,
        },
      }),
  );
}
