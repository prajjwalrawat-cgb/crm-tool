import type { DealStage } from '@/db/schema';

/**
 * Module 4 — Forecast categories. Pure, dependency-free vocabulary + the
 * stage→category derivation, so both the server rollup and the client UI import
 * the same source of truth.
 *
 * A deal's category is auto-derived from its stage, but is manually overridable
 * per deal (deals.forecast_category_overridden). Stage changes re-derive the
 * category ONLY when it hasn't been overridden — the override is the whole point
 * of forecast categories.
 */

export const FORECAST_CATEGORIES = [
  'pipeline',
  'best_case',
  'commit',
  'closed_won',
  'omitted',
] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

export const FORECAST_CATEGORY_LABELS: Record<ForecastCategory, string> = {
  pipeline: 'Pipeline',
  best_case: 'Best case',
  commit: 'Commit',
  closed_won: 'Closed won',
  omitted: 'Omitted',
};

/**
 * Default category derived from the deal's stage:
 *   Lead / Qualified → pipeline
 *   Proposal         → best_case
 *   Negotiation      → commit
 *   Won              → closed_won
 *   Lost / Hold      → omitted (not part of the forecast)
 */
export function deriveForecastCategory(stage: DealStage): ForecastCategory {
  switch (stage) {
    case 'lead':
    case 'qualified':
      return 'pipeline';
    case 'proposal':
      return 'best_case';
    case 'negotiation':
      return 'commit';
    case 'won':
      return 'closed_won';
    case 'lost':
    case 'hold':
      return 'omitted';
    default:
      return 'pipeline';
  }
}

/** Categories that roll into the "Commit" summary number. */
export const COMMIT_CATEGORIES: ForecastCategory[] = ['commit', 'closed_won'];

/** Categories that roll into the "Best case" summary number. */
export const BEST_CASE_CATEGORIES: ForecastCategory[] = [
  'commit',
  'closed_won',
  'best_case',
];

export function isCommitCategory(c: ForecastCategory): boolean {
  return COMMIT_CATEGORIES.includes(c);
}

export function isBestCaseCategory(c: ForecastCategory): boolean {
  return BEST_CASE_CATEGORIES.includes(c);
}
