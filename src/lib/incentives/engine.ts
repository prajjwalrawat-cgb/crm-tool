/**
 * THE INCENTIVE ENGINE — the one implementation of the Sales Lead incentive
 * plan (workbook: Plan Summary / Inputs / Calculator / Ladder).
 *
 * Every figure on every incentive screen — the SPOC calculator, the overshoot
 * slider, the ladder, the admin preview, the roll-up, the bulk-change preview
 * and the API — comes out of `calculateIncentive` / `computeFromCredited`
 * below. Nothing else in the codebase is allowed to multiply a slab rate. If a
 * screen needs a number this module doesn't produce, add it HERE, so the
 * figure the SPOC sees and the figure the admin approves cannot disagree.
 *
 * Pure + client-safe (no DB, no `server-only`): the overshoot slider runs it
 * in the browser on every drag.
 *
 * UNITS. Revenue in ₹ Crore (`…Cr`), compensation in ₹ Lakh (`…L`), ratios as
 * fractions (0.20 = 20%). 1 Cr = 100 L, which step 18 relies on.
 *
 * ARITHMETIC. Exact rationals throughout (see ./rational), rounded once at the
 * output to 6 decimal places. Inputs may be numbers or decimal strings —
 * Postgres `numeric` columns arrive as strings and are passed straight in.
 */

import { R, Rational, type Decimalish } from './rational';

export const ACCRUAL_BASES = ['pro_rata', 'full_step_only'] as const;
export type AccrualBasis = (typeof ACCRUAL_BASES)[number];

export const MARGIN_MISS_TREATMENTS = ['pro_rata', 'nil', 'ignore'] as const;
export type MarginMissTreatment = (typeof MARGIN_MISS_TREATMENTS)[number];

/** The per-resource, per-FY plan terms. Mirrors the workbook's Inputs sheet. */
export type IncentivePlanTerms = {
  /** ₹ L. */
  fixedCTC: Decimalish;
  /** ₹ L — the variable "pickup" in the offer. 100% of target = this. */
  targetVariable: Decimalish;
  /** ₹ Cr credited revenue. Below this the incentive is nil. */
  gateRevenueCr: Decimalish;
  /** ₹ L paid in full once the gate is crossed. */
  gateIncentiveL: Decimalish;
  /** ₹ Cr. Slab 1 runs from the gate up to here. */
  slab1UpperCr: Decimalish;
  /** ₹ L per step above the gate. */
  slab1RateL: Decimalish;
  /** ₹ L per step above `slab1UpperCr`. */
  slab2RateL: Decimalish;
  /** ₹ Cr — the size of one "every 1 Cr" unit. */
  stepCr: Decimalish;
  accrualBasis: AccrualBasis;
  capEnabled: boolean;
  /** ₹ L. Read only when `capEnabled`. */
  capAmountL: Decimalish | null;
  /** Weight on revenue from deals closed in an earlier FY. */
  priorYearCreditPct: Decimalish;
  /** Weight on revenue from deals closed in this FY. */
  netNewCreditPct: Decimalish;
  marginFloorPct: Decimalish;
  marginMissTreatment: MarginMissTreatment;
};

/** Live or forecast actuals. */
export type IncentiveActuals = {
  /** ₹ Cr recognised this FY from deals closed in an earlier FY. */
  priorYearRevenueCr: Decimalish;
  /** ₹ Cr recognised this FY from deals closed in this FY. */
  netNewRevenueCr: Decimalish;
  /** Revenue-weighted actual margin, as a fraction. */
  blendedMarginPct: Decimalish;
};

/** The workbook's default plan. Also the seed for a tenant's template. */
export const WORKBOOK_DEFAULT_TERMS = {
  fixedCTC: '22',
  targetVariable: '10',
  gateRevenueCr: '5',
  gateIncentiveL: '3',
  slab1UpperCr: '10',
  slab1RateL: '1',
  slab2RateL: '2',
  stepCr: '1',
  accrualBasis: 'pro_rata',
  capEnabled: false,
  capAmountL: null,
  priorYearCreditPct: '0.25',
  netNewCreditPct: '1',
  marginFloorPct: '0.2',
  marginMissTreatment: 'pro_rata',
} as const satisfies IncentivePlanTerms;

/* ------------------------------------------------------------------ *
 * Validation                                                          *
 * ------------------------------------------------------------------ */

export class IncentiveInputError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid incentive input: ${issues.join('; ')}`);
    this.name = 'IncentiveInputError';
    this.issues = issues;
  }
}

function tryParse(v: unknown): Rational | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Rational) return v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  try {
    return Rational.parse(v);
  } catch {
    return null;
  }
}

/** Upper bound on the two credit weights. Generous; catches "25" typed for 25%. */
const MAX_CREDIT_PCT = Rational.parse('5');

/**
 * Every problem with a plan, as user-facing sentences. Empty = valid. The
 * admin form shows these verbatim, and `calculateIncentive` refuses to run on
 * a plan that has any — a plan that can't be computed must never render a ₹0
 * that looks like a real answer.
 */
export function validatePlanTerms(plan: Partial<Record<keyof IncentivePlanTerms, unknown>>): string[] {
  const issues: string[] = [];
  const num = (key: keyof IncentivePlanTerms, label: string): Rational | null => {
    const r = tryParse(plan[key]);
    if (!r) issues.push(`${label} is required`);
    else if (r.isNegative()) issues.push(`${label} cannot be negative`);
    return r;
  };
  num('fixedCTC', 'Fixed CTC');
  num('targetVariable', 'Target variable');
  const gate = num('gateRevenueCr', 'Gate revenue');
  num('gateIncentiveL', 'Gate incentive');
  const upper = num('slab1UpperCr', 'Slab 1 upper limit');
  num('slab1RateL', 'Slab 1 rate');
  num('slab2RateL', 'Slab 2 rate');
  const step = num('stepCr', 'Step size');
  const prior = num('priorYearCreditPct', 'Prior-year credit %');
  const netNew = num('netNewCreditPct', 'Net-new credit %');
  const floor = num('marginFloorPct', 'Margin floor');

  if (step && step.isZero()) issues.push('Step size must be greater than 0');
  if (gate && upper && upper.lt(gate)) {
    issues.push('Slab 1 upper limit must be at or above the gate');
  }
  if (prior && prior.gt(MAX_CREDIT_PCT)) issues.push('Prior-year credit weight can’t exceed 500%');
  if (netNew && netNew.gt(MAX_CREDIT_PCT)) issues.push('Net-new credit weight can’t exceed 500%');
  if (floor && floor.gt(Rational.ONE)) issues.push('Margin floor can’t exceed 100%');

  if (!ACCRUAL_BASES.includes(plan.accrualBasis as AccrualBasis)) {
    issues.push('Accrual basis must be pro_rata or full_step_only');
  }
  if (!MARGIN_MISS_TREATMENTS.includes(plan.marginMissTreatment as MarginMissTreatment)) {
    issues.push('Margin-miss treatment must be pro_rata, nil or ignore');
  }
  if (typeof plan.capEnabled !== 'boolean') issues.push('Cap on/off is required');
  if (plan.capEnabled === true) {
    const cap = tryParse(plan.capAmountL);
    if (!cap) issues.push('Cap amount is required when the cap is on');
    else if (cap.isNegative()) issues.push('Cap amount cannot be negative');
  }
  return issues;
}

/** Problems with a set of actuals. Missing or negative figures are rejected. */
export function validateActuals(a: Partial<Record<keyof IncentiveActuals, unknown>>): string[] {
  const issues: string[] = [];
  const check = (key: keyof IncentiveActuals, label: string) => {
    const r = tryParse(a[key]);
    if (!r) issues.push(`${label} is required`);
    else if (r.isNegative()) issues.push(`${label} cannot be negative`);
    return r;
  };
  check('priorYearRevenueCr', 'Prior-year revenue');
  check('netNewRevenueCr', 'Net-new revenue');
  const m = check('blendedMarginPct', 'Blended margin');
  if (m && m.gt(Rational.ONE)) issues.push('Blended margin can’t exceed 100%');
  return issues;
}

/* ------------------------------------------------------------------ *
 * Exact internal plan                                                 *
 * ------------------------------------------------------------------ */

type ExactPlan = {
  fixedCTC: Rational;
  targetVariable: Rational;
  gate: Rational;
  gateIncentive: Rational;
  slab1Upper: Rational;
  slab1Rate: Rational;
  slab2Rate: Rational;
  step: Rational;
  accrualBasis: AccrualBasis;
  capEnabled: boolean;
  capAmount: Rational;
  priorCredit: Rational;
  netNewCredit: Rational;
  marginFloor: Rational;
  marginMiss: MarginMissTreatment;
};

function exactPlan(plan: IncentivePlanTerms): ExactPlan {
  const issues = validatePlanTerms(plan);
  if (issues.length > 0) throw new IncentiveInputError(issues);
  return {
    fixedCTC: R(plan.fixedCTC),
    targetVariable: R(plan.targetVariable),
    gate: R(plan.gateRevenueCr),
    gateIncentive: R(plan.gateIncentiveL),
    slab1Upper: R(plan.slab1UpperCr),
    slab1Rate: R(plan.slab1RateL),
    slab2Rate: R(plan.slab2RateL),
    step: R(plan.stepCr),
    accrualBasis: plan.accrualBasis,
    capEnabled: plan.capEnabled,
    capAmount: plan.capEnabled && plan.capAmountL != null ? R(plan.capAmountL) : Rational.ZERO,
    priorCredit: R(plan.priorYearCreditPct),
    netNewCredit: R(plan.netNewCreditPct),
    marginFloor: R(plan.marginFloorPct),
    marginMiss: plan.marginMissTreatment,
  };
}

/* ------------------------------------------------------------------ *
 * Forward calculation                                                 *
 * ------------------------------------------------------------------ */

export type IncentiveResult = {
  // Steps 1–4
  priorYearCredited: number;
  netNewCredited: number;
  creditedRevenue: number;
  netNewShareOfCredited: number;
  // Steps 5–11
  gateMet: boolean;
  /** Credited revenue still needed to cross the gate; 0 once crossed. */
  gateShortfallCr: number;
  slab1Span: number;
  slab2Span: number;
  gateIncentive: number;
  slab1Incentive: number;
  slab2Incentive: number;
  grossIncentive: number;
  // Steps 12–14
  afterCap: number;
  /** True when the cap actually cut the gross. */
  capApplied: boolean;
  marginMultiplier: number;
  finalPayoutL: number;
  // Steps 15–17
  payoutPctOfTarget: number;
  totalCashCompL: number;
  variableShareOfCash: number;
  // Step 18
  totalActualRevenueCr: number;
  marginContributionCr: number;
  incentiveAsPctOfMargin: number;
  incentiveAsPctOfRevenue: number;
};

type ExactCore = {
  gateMet: boolean;
  slab1Span: Rational;
  slab2Span: Rational;
  gateIncentive: Rational;
  slab1Incentive: Rational;
  slab2Incentive: Rational;
  gross: Rational;
  afterCap: Rational;
  marginMultiplier: Rational;
  finalPayout: Rational;
};

function accrue(raw: Rational, p: ExactPlan): Rational {
  return p.accrualBasis === 'full_step_only' ? raw.div(p.step).floor().mul(p.step) : raw;
}

/** Steps 5–14 from an already-credited revenue figure. */
function coreFromCredited(p: ExactPlan, credited: Rational, margin: Rational): ExactCore {
  // 5
  const gateMet = credited.gte(p.gate);
  // 6
  const raw1 = Rational.max(Rational.ZERO, Rational.min(credited, p.slab1Upper).sub(p.gate));
  const slab1Span = gateMet ? accrue(raw1, p) : Rational.ZERO;
  // 7
  const raw2 = Rational.max(Rational.ZERO, credited.sub(p.slab1Upper));
  const slab2Span = gateMet ? accrue(raw2, p) : Rational.ZERO;
  // 8–10
  const gateIncentive = gateMet ? p.gateIncentive : Rational.ZERO;
  const slab1Incentive = slab1Span.div(p.step).mul(p.slab1Rate);
  const slab2Incentive = slab2Span.div(p.step).mul(p.slab2Rate);
  // 11
  const gross = gateIncentive.add(slab1Incentive).add(slab2Incentive);
  // 12
  const afterCap = p.capEnabled ? Rational.min(gross, p.capAmount) : gross;
  // 13
  let marginMultiplier: Rational;
  if (p.marginMiss === 'ignore') marginMultiplier = Rational.ONE;
  else if (margin.gte(p.marginFloor)) marginMultiplier = Rational.ONE;
  else if (p.marginMiss === 'nil') marginMultiplier = Rational.ZERO;
  // pro_rata. marginFloor > 0 here: a 0 floor is always met above.
  else marginMultiplier = margin.div(p.marginFloor);
  // 14
  const finalPayout = afterCap.mul(marginMultiplier);
  return {
    gateMet,
    slab1Span,
    slab2Span,
    gateIncentive,
    slab1Incentive,
    slab2Incentive,
    gross,
    afterCap,
    marginMultiplier,
    finalPayout,
  };
}

const DP = 6;
const n = (r: Rational) => r.toNumber(DP);
const ratio = (a: Rational, b: Rational) => (b.isZero() ? Rational.ZERO : a.div(b));

/**
 * The workbook's Calculator sheet, steps 1–18, in order. Throws
 * `IncentiveInputError` on an invalid plan or on missing/negative actuals.
 */
export function calculateIncentive(
  plan: IncentivePlanTerms,
  actuals: IncentiveActuals,
): IncentiveResult {
  const p = exactPlan(plan);
  const actualIssues = validateActuals(actuals);
  if (actualIssues.length > 0) throw new IncentiveInputError(actualIssues);
  const prior = R(actuals.priorYearRevenueCr);
  const netNew = R(actuals.netNewRevenueCr);
  const margin = R(actuals.blendedMarginPct);

  // 1–4
  const priorYearCredited = prior.mul(p.priorCredit);
  const netNewCredited = netNew.mul(p.netNewCredit);
  const credited = priorYearCredited.add(netNewCredited);
  const netNewShare = ratio(netNewCredited, credited);

  const c = coreFromCredited(p, credited, margin);

  // 15–17
  const payoutPct = ratio(c.finalPayout, p.targetVariable);
  const totalCash = p.fixedCTC.add(c.finalPayout);
  const variableShare = ratio(c.finalPayout, totalCash);

  // 18 — company economics. finalPayout is in L; /100 converts to Cr.
  const totalRevenue = prior.add(netNew);
  const marginContribution = totalRevenue.mul(margin);
  const payoutCr = c.finalPayout.div(Rational.parse(100));

  return {
    priorYearCredited: n(priorYearCredited),
    netNewCredited: n(netNewCredited),
    creditedRevenue: n(credited),
    netNewShareOfCredited: n(netNewShare),
    gateMet: c.gateMet,
    gateShortfallCr: n(Rational.max(Rational.ZERO, p.gate.sub(credited))),
    slab1Span: n(c.slab1Span),
    slab2Span: n(c.slab2Span),
    gateIncentive: n(c.gateIncentive),
    slab1Incentive: n(c.slab1Incentive),
    slab2Incentive: n(c.slab2Incentive),
    grossIncentive: n(c.gross),
    afterCap: n(c.afterCap),
    capApplied: p.capEnabled && c.gross.gt(p.capAmount),
    marginMultiplier: n(c.marginMultiplier),
    finalPayoutL: n(c.finalPayout),
    payoutPctOfTarget: n(payoutPct),
    totalCashCompL: n(totalCash),
    variableShareOfCash: n(variableShare),
    totalActualRevenueCr: n(totalRevenue),
    marginContributionCr: n(marginContribution),
    incentiveAsPctOfMargin: n(ratio(payoutCr, marginContribution)),
    incentiveAsPctOfRevenue: n(ratio(payoutCr, totalRevenue)),
  };
}

export type CreditedPoint = {
  creditedRevenueCr: number;
  gateMet: boolean;
  gateIncentive: number;
  slab1Incentive: number;
  slab2Incentive: number;
  grossIncentive: number;
  afterCap: number;
  finalPayoutL: number;
  payoutPctOfTarget: number;
};

/**
 * Steps 5–15 for a credited-revenue figure directly, ASSUMING THE MARGIN
 * FLOOR IS MET (multiplier 1). This is what the Ladder sheet tabulates. The
 * same `coreFromCredited` that `calculateIncentive` runs — not a copy.
 */
export function computeFromCredited(
  plan: IncentivePlanTerms,
  creditedRevenueCr: Decimalish,
): CreditedPoint {
  const p = exactPlan(plan);
  const credited = R(creditedRevenueCr);
  // A margin at the floor is "met" under every treatment.
  const c = coreFromCredited(p, credited, p.marginFloor);
  return {
    creditedRevenueCr: n(credited),
    gateMet: c.gateMet,
    gateIncentive: n(c.gateIncentive),
    slab1Incentive: n(c.slab1Incentive),
    slab2Incentive: n(c.slab2Incentive),
    grossIncentive: n(c.gross),
    afterCap: n(c.afterCap),
    finalPayoutL: n(c.finalPayout),
    payoutPctOfTarget: n(ratio(c.finalPayout, p.targetVariable)),
  };
}

/* ------------------------------------------------------------------ *
 * Reverse calculation                                                 *
 * ------------------------------------------------------------------ */

export type TargetRevenueNeeded =
  | { reachable: true; creditedRevenueCr: number }
  | {
      reachable: false;
      creditedRevenueCr: null;
      /** Why no revenue figure produces a full-target payout. */
      reason: 'cap_below_target' | 'no_rate_above_gate';
    };

/**
 * Credited revenue at which `finalPayoutL == targetVariable`, margin floor
 * met — steps 6–11 inverted.
 *
 * For `pro_rata` this is exactly the workbook formula. Two cases the
 * workbook's formula doesn't cover are handled rather than allowed to print
 * a misleading number:
 *   * `full_step_only` pays only on completed steps, so the formula's answer
 *     is rounded UP to the step boundary where the payout actually lands —
 *     otherwise a SPOC who hits the quoted figure would still fall short.
 *   * A cap below the target, or a zero rate on every slab that would have to
 *     carry the remainder, makes 100% unreachable. That is reported as such,
 *     not as a revenue figure that would not in fact pay out.
 */
export function creditedRevenueForFullTarget(plan: IncentivePlanTerms): TargetRevenueNeeded {
  const p = exactPlan(plan);
  const target = p.targetVariable;
  if (p.capEnabled && p.capAmount.lt(target)) {
    return { reachable: false, creditedRevenueCr: null, reason: 'cap_below_target' };
  }
  if (target.lte(p.gateIncentive)) {
    return { reachable: true, creditedRevenueCr: n(p.gate) };
  }
  const stepped = p.accrualBasis === 'full_step_only';
  const slab1Width = p.slab1Upper.sub(p.gate);
  // Steps slab 1 can actually pay for: fractional under pro_rata, whole only
  // under full_step_only.
  const slab1Steps = stepped ? slab1Width.div(p.step).floor() : slab1Width.div(p.step);
  const slab1Max = slab1Steps.mul(p.slab1Rate);
  const afterGate = target.sub(p.gateIncentive);

  if (afterGate.lte(slab1Max) && !p.slab1Rate.isZero()) {
    let steps = afterGate.div(p.slab1Rate);
    if (stepped) steps = steps.ceil();
    return { reachable: true, creditedRevenueCr: n(p.gate.add(steps.mul(p.step))) };
  }
  if (p.slab2Rate.isZero()) {
    return { reachable: false, creditedRevenueCr: null, reason: 'no_rate_above_gate' };
  }
  let steps = afterGate.sub(slab1Max).div(p.slab2Rate);
  if (stepped) steps = steps.ceil();
  return { reachable: true, creditedRevenueCr: n(p.slab1Upper.add(steps.mul(p.step))) };
}

/* ------------------------------------------------------------------ *
 * "What it takes"                                                     *
 * ------------------------------------------------------------------ */

export type WhatItTakes = {
  needed: TargetRevenueNeeded;
  currentCreditedCr: number;
  /** Credited revenue still to find; 0 once reached. Null if unreachable. */
  creditedGapCr: number | null;
  /** Net-new revenue that closes the gap at the net-new weight. */
  netNewRevenueNeededCr: number | null;
  /** Net-new revenue the SPOC would be at in total. */
  netNewRevenueTotalCr: number | null;
  netNewCreditPct: number;
  alreadyThere: boolean;
};

/**
 * How much more NET-NEW revenue reaches full target, holding prior-year
 * revenue fixed (it is already contracted). The UI shows the arithmetic
 * from these fields: gap ÷ net-new weight = net-new needed.
 */
export function whatItTakes(plan: IncentivePlanTerms, actuals: IncentiveActuals): WhatItTakes {
  const result = calculateIncentive(plan, actuals);
  const needed = creditedRevenueForFullTarget(plan);
  const netNewWeight = R(plan.netNewCreditPct);
  const current = Rational.parse(result.creditedRevenue);
  const base = {
    needed,
    currentCreditedCr: result.creditedRevenue,
    netNewCreditPct: n(netNewWeight),
  };
  if (!needed.reachable) {
    return {
      ...base,
      creditedGapCr: null,
      netNewRevenueNeededCr: null,
      netNewRevenueTotalCr: null,
      alreadyThere: false,
    };
  }
  const gap = Rational.max(Rational.ZERO, Rational.parse(needed.creditedRevenueCr).sub(current));
  const netNewNeeded = gap.isZero()
    ? Rational.ZERO
    : netNewWeight.isZero()
      ? null
      : gap.div(netNewWeight);
  return {
    ...base,
    creditedGapCr: n(gap),
    netNewRevenueNeededCr: netNewNeeded ? n(netNewNeeded) : null,
    netNewRevenueTotalCr: netNewNeeded ? n(R(actuals.netNewRevenueCr).add(netNewNeeded)) : null,
    alreadyThere: gap.isZero(),
  };
}

/* ------------------------------------------------------------------ *
 * Slab position and the next step                                     *
 * ------------------------------------------------------------------ */

export type SlabZone = 'below_gate' | 'slab1' | 'slab2';

export type NextStep = {
  /** Where the NEXT `stepCr` of credited revenue lands. */
  zone: SlabZone;
  /** Extra ₹ L the next full step of credited revenue pays, after cap and margin. */
  incrementalPayoutL: number;
  /** True when the cap absorbs some or all of that increment. */
  cappedOut: boolean;
};

/** Which slab the next step of credited revenue falls into, and what it pays. */
export function nextStepFor(plan: IncentivePlanTerms, actuals: IncentiveActuals): NextStep {
  const p = exactPlan(plan);
  const now = calculateIncentive(plan, actuals);
  const credited = Rational.parse(now.creditedRevenue);
  const zone: SlabZone = credited.lt(p.gate)
    ? 'below_gate'
    : credited.lt(p.slab1Upper)
      ? 'slab1'
      : 'slab2';
  // One more step of CREDITED revenue = step ÷ net-new weight of net-new.
  const extraNetNew = p.netNewCredit.isZero() ? Rational.ZERO : p.step.div(p.netNewCredit);
  const next = calculateIncentive(plan, {
    ...actuals,
    netNewRevenueCr: R(actuals.netNewRevenueCr).add(extraNetNew),
  });
  const grossDelta = next.grossIncentive - now.grossIncentive;
  const afterCapDelta = next.afterCap - now.afterCap;
  return {
    zone,
    incrementalPayoutL: n(Rational.parse(next.finalPayoutL).sub(Rational.parse(now.finalPayoutL))),
    cappedOut: p.capEnabled && afterCapDelta < grossDelta,
  };
}

/* ------------------------------------------------------------------ *
 * Ladder                                                              *
 * ------------------------------------------------------------------ */

export type LadderRow = CreditedPoint & {
  zone: SlabZone;
  /** The row the SPOC's current credited revenue falls in. */
  isCurrent: boolean;
};

/**
 * The Ladder sheet: payout at each step of credited revenue from the gate to
 * `slab1Upper + extraSteps` steps, margin floor assumed met. The row
 * containing `currentCreditedCr` (if given) is flagged — the highest row at
 * or below it; nothing is flagged below the gate.
 */
export function buildLadder(
  plan: IncentivePlanTerms,
  opts: { currentCreditedCr?: Decimalish | null; extraSteps?: number; maxRows?: number } = {},
): LadderRow[] {
  const p = exactPlan(plan);
  const extra = Math.max(0, Math.floor(opts.extraSteps ?? 5));
  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? 60));
  const ceiling = p.slab1Upper.add(p.step.mul(Rational.parse(extra)));
  const points: Rational[] = [];
  for (let x = p.gate; x.lte(ceiling) && points.length < maxRows; x = x.add(p.step)) {
    points.push(x);
  }
  // Slab 1's upper limit is the row where the rate changes; keep it on the
  // ladder even when it isn't a whole number of steps from the gate.
  if (!points.some((x) => x.eq(p.slab1Upper)) && points.length < maxRows) {
    points.push(p.slab1Upper);
    points.sort((a, b) => a.cmp(b));
  }
  const current = opts.currentCreditedCr != null ? R(opts.currentCreditedCr) : null;
  let currentIdx = -1;
  if (current) {
    points.forEach((x, i) => {
      if (x.lte(current)) currentIdx = i;
    });
  }
  return points.map((x, i) => ({
    ...computeFromCredited(plan, x),
    zone: x.lt(p.gate) ? 'below_gate' : x.lt(p.slab1Upper) ? 'slab1' : 'slab2',
    isCurrent: i === currentIdx,
  }));
}

/* ------------------------------------------------------------------ *
 * Margin callout                                                      *
 * ------------------------------------------------------------------ */

export type MarginStatus =
  | { kind: 'met' }
  | { kind: 'not_enforced' }
  | { kind: 'reduced'; payoutPctOfGross: number }
  | { kind: 'nil' };

/** The margin treatment actually in effect for these actuals. */
export function marginStatus(plan: IncentivePlanTerms, actuals: IncentiveActuals): MarginStatus {
  const r = calculateIncentive(plan, actuals);
  if (plan.marginMissTreatment === 'ignore') return { kind: 'not_enforced' };
  if (R(actuals.blendedMarginPct).gte(R(plan.marginFloorPct))) return { kind: 'met' };
  if (plan.marginMissTreatment === 'nil') return { kind: 'nil' };
  return { kind: 'reduced', payoutPctOfGross: r.marginMultiplier };
}

/* ------------------------------------------------------------------ *
 * Roll-up flags                                                       *
 * ------------------------------------------------------------------ */

export type ResourceFlags = {
  belowGate: boolean;
  marginMiss: boolean;
  /** On track to EXCEED target — the "breach" / over-achievement case. */
  breach: boolean;
};

export function resourceFlags(
  plan: IncentivePlanTerms,
  actuals: IncentiveActuals,
  result: IncentiveResult = calculateIncentive(plan, actuals),
): ResourceFlags {
  return {
    belowGate: !result.gateMet,
    marginMiss:
      plan.marginMissTreatment !== 'ignore' &&
      R(actuals.blendedMarginPct).lt(R(plan.marginFloorPct)),
    breach: result.payoutPctOfTarget > 1,
  };
}

/** Exact sum of payouts, for roll-up totals — no float accumulation. */
export function sumPayoutsL(values: readonly number[]): number {
  return n(values.reduce((acc, v) => acc.add(Rational.parse(v)), Rational.ZERO));
}

/* ------------------------------------------------------------------ *
 * What-if input                                                       *
 * ------------------------------------------------------------------ */

/**
 * The same actuals with `extraNetNewCr` more net-new revenue — the overshoot
 * slider's input. Exact, so a hypothetical at +3 Cr equals actuals typed in
 * at the same total.
 */
export function withExtraNetNew(actuals: IncentiveActuals, extraNetNewCr: Decimalish): IncentiveActuals {
  return { ...actuals, netNewRevenueCr: R(actuals.netNewRevenueCr).add(R(extraNetNewCr)) };
}
