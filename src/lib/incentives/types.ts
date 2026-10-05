/**
 * Serializable view models for incentive pages — what crosses the
 * server→client boundary. Decimal fields stay strings so the client engine
 * parses them exactly as the server would.
 *
 * Pure + client-safe.
 */
import type { IncentiveActuals } from './engine';
import type { PlanStatus } from './rollup';
import type { StoredTerms } from './terms';

export type ActualsSource = 'manual' | 'computed';

export type PlanView = {
  id: string;
  userId: string;
  fiscalYear: number;
  fiscalLabel: string;
  status: PlanStatus;
  actualsSource: ActualsSource;
  version: number;
  terms: StoredTerms;
  updatedAt: string;
  updatedBy: string | null;
};

export type ActualsView = {
  id: string;
  asOfDate: string;
  priorYearRevenueCr: string;
  netNewRevenueCr: string;
  blendedMarginPct: string;
  source: ActualsSource;
  enteredBy: string | null;
  computedAt: string | null;
  createdAt: string;
  details: Record<string, unknown>;
};

export function actualsInput(a: ActualsView): IncentiveActuals {
  return {
    priorYearRevenueCr: a.priorYearRevenueCr,
    netNewRevenueCr: a.netNewRevenueCr,
    blendedMarginPct: a.blendedMarginPct,
  };
}

export type VersionView = {
  version: number;
  action: string;
  changedBy: string | null;
  changedAt: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  note: string | null;
};

export const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'active', 'closed'];
export const ACTUALS_SOURCES: readonly ActualsSource[] = ['manual', 'computed'];
