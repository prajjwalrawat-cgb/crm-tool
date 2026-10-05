/**
 * The three sample plan shapes the seed script writes, kept here (not in the
 * script) so the selftest hand-checks exactly the plans that get seeded.
 *
 * One of each mechanic the default plan doesn't exercise: a cap that bites,
 * a margin miss under 'nil', and full-step-only accrual.
 */
import {
  WORKBOOK_DEFAULT_TERMS,
  type IncentiveActuals,
  type IncentivePlanTerms,
} from './engine';

export type SeedPlanShape = {
  key: 'capped' | 'margin_nil' | 'full_step';
  label: string;
  terms: IncentivePlanTerms;
  actuals: IncentiveActuals;
};

export const SEED_PLAN_SHAPES: readonly SeedPlanShape[] = [
  {
    key: 'capped',
    label: 'Senior lead, capped accelerator',
    terms: {
      ...WORKBOOK_DEFAULT_TERMS,
      fixedCTC: '30',
      targetVariable: '12',
      gateRevenueCr: '6',
      gateIncentiveL: '4',
      slab1UpperCr: '12',
      slab1RateL: '1.5',
      slab2RateL: '3',
      capEnabled: true,
      capAmountL: '18',
    },
    // credited 16.5 → gross 26.5 → capped at 18.
    actuals: { priorYearRevenueCr: '10', netNewRevenueCr: '14', blendedMarginPct: '0.22' },
  },
  {
    key: 'margin_nil',
    label: 'Lead, margin floor strictly enforced',
    terms: { ...WORKBOOK_DEFAULT_TERMS, marginMissTreatment: 'nil' },
    // credited 8.5 → gross 6.5, but 17% < 20% floor → nil.
    actuals: { priorYearRevenueCr: '6', netNewRevenueCr: '7', blendedMarginPct: '0.17' },
  },
  {
    key: 'full_step',
    label: 'Associate lead, full steps only',
    terms: {
      ...WORKBOOK_DEFAULT_TERMS,
      fixedCTC: '14',
      targetVariable: '6',
      gateRevenueCr: '4',
      gateIncentiveL: '2',
      slab1UpperCr: '8',
      accrualBasis: 'full_step_only',
    },
    // credited 9.4 → 2 + 4 + 2 = 8.
    actuals: { priorYearRevenueCr: '4', netNewRevenueCr: '8.4', blendedMarginPct: '0.21' },
  },
];
