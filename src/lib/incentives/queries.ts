import 'server-only';

import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  incentiveActuals,
  incentivePlans,
  incentivePlanTemplates,
  incentivePlanVersions,
  type IncentiveActualsRow,
  type IncentivePlanRow,
  type IncentivePlanTemplateRow,
  type MembershipRole,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { fiscalYearLabel } from '@/lib/targets/fiscal';

import { canViewIncentivePlan } from './access';
import { WORKBOOK_DEFAULT_TERMS, type IncentivePlanTerms } from './engine';
import type { PlanStatus } from './rollup';
import { toStoredTerms, type StoredTerms } from './terms';
import type { ActualsSource, ActualsView, PlanView, VersionView } from './types';

/* ------------------------------------------------------------------ *
 * Row ↔ terms                                                         *
 * ------------------------------------------------------------------ */

type TermRow = Pick<
  IncentivePlanRow,
  | 'fixedCtc'
  | 'targetVariable'
  | 'gateRevenueCr'
  | 'gateIncentiveL'
  | 'slab1UpperCr'
  | 'slab1RateL'
  | 'slab2RateL'
  | 'stepCr'
  | 'accrualBasis'
  | 'capEnabled'
  | 'capAmountL'
  | 'priorYearCreditPct'
  | 'netNewCreditPct'
  | 'marginFloorPct'
  | 'marginMissTreatment'
>;

export function rowToTerms(row: TermRow): StoredTerms {
  return toStoredTerms({
    fixedCTC: row.fixedCtc,
    targetVariable: row.targetVariable,
    gateRevenueCr: row.gateRevenueCr,
    gateIncentiveL: row.gateIncentiveL,
    slab1UpperCr: row.slab1UpperCr,
    slab1RateL: row.slab1RateL,
    slab2RateL: row.slab2RateL,
    stepCr: row.stepCr,
    accrualBasis: row.accrualBasis as IncentivePlanTerms['accrualBasis'],
    capEnabled: row.capEnabled,
    capAmountL: row.capAmountL,
    priorYearCreditPct: row.priorYearCreditPct,
    netNewCreditPct: row.netNewCreditPct,
    marginFloorPct: row.marginFloorPct,
    marginMissTreatment: row.marginMissTreatment as IncentivePlanTerms['marginMissTreatment'],
  });
}

export function termsToColumns(t: StoredTerms): TermRow {
  return {
    fixedCtc: t.fixedCTC,
    targetVariable: t.targetVariable,
    gateRevenueCr: t.gateRevenueCr,
    gateIncentiveL: t.gateIncentiveL,
    slab1UpperCr: t.slab1UpperCr,
    slab1RateL: t.slab1RateL,
    slab2RateL: t.slab2RateL,
    stepCr: t.stepCr,
    accrualBasis: t.accrualBasis,
    capEnabled: t.capEnabled,
    capAmountL: t.capAmountL,
    priorYearCreditPct: t.priorYearCreditPct,
    netNewCreditPct: t.netNewCreditPct,
    marginFloorPct: t.marginFloorPct,
    marginMissTreatment: t.marginMissTreatment,
  };
}

export function toPlanView(row: IncentivePlanRow, startMonth: number): PlanView {
  return {
    id: row.id,
    userId: row.userId,
    fiscalYear: row.fiscalYear,
    fiscalLabel: fiscalYearLabel(startMonth, row.fiscalYear),
    status: row.status as PlanStatus,
    actualsSource: row.actualsSource as ActualsSource,
    version: row.version,
    terms: rowToTerms(row),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export function toActualsView(row: IncentiveActualsRow): ActualsView {
  return {
    id: row.id,
    asOfDate: row.asOfDate,
    priorYearRevenueCr: row.priorYearRevenueCr,
    netNewRevenueCr: row.netNewRevenueCr,
    blendedMarginPct: row.blendedMarginPct,
    source: row.source as ActualsSource,
    enteredBy: row.enteredBy,
    computedAt: row.computedAt ? row.computedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    details: row.details ?? {},
  };
}

/* ------------------------------------------------------------------ *
 * Template                                                            *
 * ------------------------------------------------------------------ */

export type TemplateView = { terms: StoredTerms; budgetL: string | null; updatedAt: string | null };

/** The tenant template, or the workbook defaults when none is saved yet. */
export async function getTemplate(tenantId: string): Promise<TemplateView> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select()
      .from(incentivePlanTemplates)
      .where(eq(incentivePlanTemplates.tenantId, tenantId))
      .limit(1),
  );
  if (!row) return { terms: toStoredTerms(WORKBOOK_DEFAULT_TERMS), budgetL: null, updatedAt: null };
  return templateView(row);
}

function templateView(row: IncentivePlanTemplateRow): TemplateView {
  return {
    terms: rowToTerms(row),
    budgetL: row.budgetL,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Plans                                                               *
 * ------------------------------------------------------------------ */

export async function listPlans(tenantId: string, fiscalYear: number): Promise<IncentivePlanRow[]> {
  return await tenantTransaction((tx) =>
    tx
      .select()
      .from(incentivePlans)
      .where(and(eq(incentivePlans.tenantId, tenantId), eq(incentivePlans.fiscalYear, fiscalYear))),
  );
}

export async function getPlanRow(tenantId: string, planId: string): Promise<IncentivePlanRow | null> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select()
      .from(incentivePlans)
      .where(and(eq(incentivePlans.tenantId, tenantId), eq(incentivePlans.id, planId)))
      .limit(1),
  );
  return row ?? null;
}

export async function getPlanRowForUser(
  tenantId: string,
  userId: string,
  fiscalYear: number,
): Promise<IncentivePlanRow | null> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select()
      .from(incentivePlans)
      .where(
        and(
          eq(incentivePlans.tenantId, tenantId),
          eq(incentivePlans.userId, userId),
          eq(incentivePlans.fiscalYear, fiscalYear),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/* ------------------------------------------------------------------ *
 * Actuals                                                             *
 * ------------------------------------------------------------------ */

/**
 * Latest actuals per plan, from the source each plan is set to read. One
 * query for the whole list; the newest row wins (as_of_date, then insert
 * time, so a backdated manual entry doesn't jump ahead of today's).
 */
export async function latestActualsForPlans(
  tenantId: string,
  plans: ReadonlyArray<Pick<IncentivePlanRow, 'id' | 'actualsSource'>>,
): Promise<Map<string, ActualsView>> {
  const out = new Map<string, ActualsView>();
  if (plans.length === 0) return out;
  const sourceByPlan = new Map(plans.map((p) => [p.id, p.actualsSource]));
  const rows = await tenantTransaction((tx) =>
    tx
      .select()
      .from(incentiveActuals)
      .where(
        and(
          eq(incentiveActuals.tenantId, tenantId),
          inArray(
            incentiveActuals.planId,
            plans.map((p) => p.id),
          ),
        ),
      )
      .orderBy(desc(incentiveActuals.asOfDate), desc(incentiveActuals.createdAt)),
  );
  for (const r of rows) {
    if (out.has(r.planId)) continue;
    if (sourceByPlan.get(r.planId) !== r.source) continue;
    out.set(r.planId, toActualsView(r));
  }
  return out;
}

export async function actualsHistory(
  tenantId: string,
  planId: string,
  limit = 60,
): Promise<ActualsView[]> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select()
      .from(incentiveActuals)
      .where(and(eq(incentiveActuals.tenantId, tenantId), eq(incentiveActuals.planId, planId)))
      .orderBy(desc(incentiveActuals.asOfDate), desc(incentiveActuals.createdAt))
      .limit(limit),
  );
  return rows.map(toActualsView);
}

export async function listVersions(tenantId: string, planId: string): Promise<VersionView[]> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select()
      .from(incentivePlanVersions)
      .where(and(eq(incentivePlanVersions.tenantId, tenantId), eq(incentivePlanVersions.planId, planId)))
      .orderBy(desc(incentivePlanVersions.version)),
  );
  return rows.map((r) => ({
    version: r.version,
    action: r.action,
    changedBy: r.changedBy,
    changedAt: r.changedAt.toISOString(),
    changes: r.changes ?? {},
    note: r.note,
  }));
}

/* ------------------------------------------------------------------ *
 * Viewer-scoped load — the only read path pages and the API use       *
 * ------------------------------------------------------------------ */

export type PlanBundle = {
  plan: PlanView;
  actuals: ActualsView | null;
};

/**
 * A plan + its current actuals, IF the viewer may see it. Returns null both
 * when the plan doesn't exist and when it belongs to someone the viewer may
 * not see, so a guessed id can't be used to probe whether a colleague has a
 * plan.
 */
export async function loadPlanForViewer(
  tenantId: string,
  viewer: { userId: string; role: MembershipRole | null },
  planId: string,
  startMonth: number,
): Promise<PlanBundle | null> {
  const row = await getPlanRow(tenantId, planId);
  if (!row || !canViewIncentivePlan(viewer, row)) return null;
  // A SPOC sees their plan only once it's live; drafts are the admin's.
  if (row.userId === viewer.userId && row.status === 'draft' && !canSeeDrafts(viewer.role)) return null;
  const actuals = (await latestActualsForPlans(tenantId, [row])).get(row.id) ?? null;
  return { plan: toPlanView(row, startMonth), actuals };
}

function canSeeDrafts(role: MembershipRole | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'manager';
}

/** The viewer's own non-draft plan for a fiscal year, with current actuals. */
export async function loadMyPlan(
  tenantId: string,
  userId: string,
  fiscalYear: number,
  startMonth: number,
): Promise<PlanBundle | null> {
  const row = await getPlanRowForUser(tenantId, userId, fiscalYear);
  if (!row || row.status === 'draft') return null;
  const actuals = (await latestActualsForPlans(tenantId, [row])).get(row.id) ?? null;
  return { plan: toPlanView(row, startMonth), actuals };
}
