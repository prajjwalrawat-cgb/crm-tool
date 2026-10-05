/**
 * Self-test for the Sales Incentive Calculator.
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-incentives.ts
 *
 * The worked examples come first and are written against the source
 * workbook's own numbers — not against whatever the engine happens to
 * output. If one of them moves, the engine is wrong, not the test.
 *
 * Pure sections always run. The database sections (computed actuals,
 * idempotent re-runs, SPOC isolation through the query layer) need
 * DATABASE_URL and are SKIPPED, not failed, without one — matching the other
 * selftests. They build their own tenant and drop it afterwards.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from 'dotenv';

config({ path: '.env.local' });
config();

import {
  buildLadder,
  calculateIncentive,
  computeFromCredited,
  creditedRevenueForFullTarget,
  IncentiveInputError,
  marginStatus,
  nextStepFor,
  resourceFlags,
  sumPayoutsL,
  validateActuals,
  validatePlanTerms,
  whatItTakes,
  WORKBOOK_DEFAULT_TERMS,
  type IncentiveActuals,
  type IncentivePlanTerms,
} from '../src/lib/incentives/engine';
import { Rational } from '../src/lib/incentives/rational';
import { SEED_PLAN_SHAPES } from '../src/lib/incentives/seed-shapes';
import { canEnterManualActuals, canViewIncentivePlan } from '../src/lib/incentives/access';
import { applyBulkChange, previewBulkChange } from '../src/lib/incentives/bulk';
import { buildRollup } from '../src/lib/incentives/rollup';
import { diffTerms } from '../src/lib/incentives/terms';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}
function throwsInputError(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof IncentiveInputError;
  }
}

const PLAN: IncentivePlanTerms = { ...WORKBOOK_DEFAULT_TERMS };
const act = (prior: number | string, netNew: number | string, margin: number | string): IncentiveActuals => ({
  priorYearRevenueCr: prior,
  netNewRevenueCr: netNew,
  blendedMarginPct: margin,
});

/* ------------------------------------------------------------------ *
 * 1. The workbook's worked examples                                   *
 * ------------------------------------------------------------------ */
{
  const r = calculateIncentive(PLAN, act(8, 6, 0.2));
  check(
    'WB1 prior=8 netNew=6 m=0.20 → credited 8, gate met, s1 3, s2 0, gross 6, payout 6, 60%',
    r.creditedRevenue === 8 &&
      r.gateMet &&
      r.slab1Incentive === 3 &&
      r.slab2Incentive === 0 &&
      r.grossIncentive === 6 &&
      r.marginMultiplier === 1 &&
      r.finalPayoutL === 6 &&
      r.payoutPctOfTarget === 0.6,
    JSON.stringify(r),
  );
}
{
  const r = calculateIncentive(PLAN, act(8, 6, 0.18));
  check(
    'WB2 margin 0.18 (pro_rata) → multiplier 0.9, payout exactly 5.4',
    r.marginMultiplier === 0.9 && r.finalPayoutL === 5.4,
    `mult=${r.marginMultiplier} payout=${r.finalPayoutL}`,
  );
}
{
  const r = calculateIncentive({ ...PLAN, marginMissTreatment: 'nil' }, act(8, 6, 0.18));
  check('WB3 margin 0.18 + nil → payout 0', r.finalPayoutL === 0 && r.grossIncentive === 6);
}
{
  const r = calculateIncentive(PLAN, act(8, 10, 0.2));
  check(
    'WB4 prior=8 netNew=10 → credited 12, s1 5, s2 4, gross 12, payout 12 (120%, breach)',
    r.creditedRevenue === 12 &&
      r.slab1Incentive === 5 &&
      r.slab2Incentive === 4 &&
      r.grossIncentive === 12 &&
      r.finalPayoutL === 12 &&
      r.payoutPctOfTarget === 1.2,
    JSON.stringify(r),
  );
  check('WB4 is flagged as a breach', resourceFlags(PLAN, act(8, 10, 0.2)).breach);
}
{
  const need = creditedRevenueForFullTarget(PLAN);
  check(
    'WB5 credited revenue needed for full target = 11 Cr',
    need.reachable && need.creditedRevenueCr === 11,
    JSON.stringify(need),
  );
  // And the forward engine agrees with the reverse one.
  check('WB5 forward check: 11 Cr credited pays exactly the 10 L target', computeFromCredited(PLAN, 11).finalPayoutL === 10);
}
{
  const r = calculateIncentive(PLAN, act(0, 0, 0.2));
  check(
    'WB6 credited 0 → gate not met, every component 0',
    !r.gateMet &&
      r.gateIncentive === 0 &&
      r.slab1Incentive === 0 &&
      r.slab2Incentive === 0 &&
      r.grossIncentive === 0 &&
      r.finalPayoutL === 0 &&
      r.netNewShareOfCredited === 0 &&
      r.incentiveAsPctOfRevenue === 0 &&
      r.incentiveAsPctOfMargin === 0,
  );
}

/* ------------------------------------------------------------------ *
 * 2. Remaining calculator outputs (steps 4, 16–18)                    *
 * ------------------------------------------------------------------ */
{
  const r = calculateIncentive(PLAN, act(8, 6, 0.2));
  // credited 8 = 2 prior + 6 net-new → 75% net-new share.
  check('netNewShareOfCredited = 0.75', r.netNewShareOfCredited === 0.75);
  check('totalCashComp = 22 + 6 = 28', r.totalCashCompL === 28);
  check('variableShareOfCash = 6/28', r.variableShareOfCash === Number((6 / 28).toFixed(6)));
  // revenue 14 Cr × 20% = 2.8 Cr margin; payout 6 L = 0.06 Cr.
  check('marginContribution = 2.8 Cr', r.marginContributionCr === 2.8);
  check('incentive % of margin = 0.06/2.8', r.incentiveAsPctOfMargin === Number((0.06 / 2.8).toFixed(6)));
  check('incentive % of revenue = 0.06/14', r.incentiveAsPctOfRevenue === Number((0.06 / 14).toFixed(6)));
}

/* ------------------------------------------------------------------ *
 * 3. Edges                                                            *
 * ------------------------------------------------------------------ */
{
  const atGate = computeFromCredited(PLAN, 5);
  check('credited exactly at gate → gate met, gate incentive only (3)', atGate.gateMet && atGate.finalPayoutL === 3 && atGate.slab1Incentive === 0);
  const below = computeFromCredited(PLAN, '4.999999');
  check('a hair under the gate → nil', !below.gateMet && below.finalPayoutL === 0);
  const atUpper = computeFromCredited(PLAN, 10);
  check('credited exactly at slab1Upper → 3 + 5, no slab 2', atUpper.slab1Incentive === 5 && atUpper.slab2Incentive === 0 && atUpper.finalPayoutL === 8);
  const pastUpper = computeFromCredited(PLAN, 10.5);
  check('half a step into slab 2 pays half the slab-2 rate (pro_rata)', pastUpper.slab2Incentive === 1 && pastUpper.finalPayoutL === 9);
}
check('negative actuals are rejected', throwsInputError(() => calculateIncentive(PLAN, act(-1, 6, 0.2))));
check('negative margin is rejected', throwsInputError(() => calculateIncentive(PLAN, act(8, 6, -0.1))));
check(
  'missing actuals are rejected',
  throwsInputError(() =>
    calculateIncentive(PLAN, { priorYearRevenueCr: 8, netNewRevenueCr: '', blendedMarginPct: 0.2 } as IncentiveActuals),
  ),
);
check('margin typed as 18 (not 0.18) is rejected', validateActuals(act(1, 1, 18)).length > 0);
check('zero step size is rejected', validatePlanTerms({ ...PLAN, stepCr: '0' }).length > 0);
check('slab1Upper below the gate is rejected', validatePlanTerms({ ...PLAN, slab1UpperCr: '4' }).length > 0);
check('cap on with no cap amount is rejected', validatePlanTerms({ ...PLAN, capEnabled: true, capAmountL: null }).length > 0);
check('the workbook default plan is valid', validatePlanTerms(PLAN).length === 0);
{
  const r = calculateIncentive({ ...PLAN, marginMissTreatment: 'ignore' }, act(8, 6, 0.05));
  check('ignore → margin never reduces payout', r.marginMultiplier === 1 && r.finalPayoutL === 6);
}
{
  const r = calculateIncentive({ ...PLAN, capEnabled: true, capAmountL: '10' }, act(8, 10, 0.2));
  check('cap clips gross 12 to 10', r.grossIncentive === 12 && r.afterCap === 10 && r.capApplied && r.finalPayoutL === 10);
}
{
  const r = calculateIncentive({ ...PLAN, accrualBasis: 'full_step_only' }, act(0, '7.6', 0.2));
  check('full_step_only: 7.6 Cr pays for 2 whole steps only (3 + 2)', r.slab1Span === 2 && r.finalPayoutL === 5);
}

/* ------------------------------------------------------------------ *
 * 4. Reverse calculation beyond the workbook                          *
 * ------------------------------------------------------------------ */
{
  const n1 = creditedRevenueForFullTarget({ ...PLAN, targetVariable: '2' });
  check('target ≤ gate incentive → the gate itself', n1.reachable && n1.creditedRevenueCr === 5);
  const n2 = creditedRevenueForFullTarget({ ...PLAN, targetVariable: '6.5' });
  check('target inside slab 1 → gate + (6.5-3)/1 = 8.5', n2.reachable && n2.creditedRevenueCr === 8.5);
  const n3 = creditedRevenueForFullTarget({ ...PLAN, targetVariable: '6.5', accrualBasis: 'full_step_only' });
  check('full_step_only rounds UP to the step that actually pays (9)', n3.reachable && n3.creditedRevenueCr === 9);
  check('…and 9 Cr really does pay ≥ target under full_step_only', computeFromCredited({ ...PLAN, targetVariable: '6.5', accrualBasis: 'full_step_only' }, 9).finalPayoutL >= 6.5);
  const n4 = creditedRevenueForFullTarget({ ...PLAN, capEnabled: true, capAmountL: '8' });
  check('cap below target → unreachable, not a misleading number', !n4.reachable && n4.reason === 'cap_below_target');
  const n5 = creditedRevenueForFullTarget({ ...PLAN, slab2RateL: '0' });
  check('target needs slab 2 but slab 2 rate is 0 → unreachable', !n5.reachable && n5.reason === 'no_rate_above_gate');
}

/* ------------------------------------------------------------------ *
 * 5. What it takes / next step / margin callout / ladder              *
 * ------------------------------------------------------------------ */
{
  const w = whatItTakes(PLAN, act(8, 6, 0.2));
  check('what-it-takes: need 11, at 8 → gap 3 credited = 3 Cr net-new', w.creditedGapCr === 3 && w.netNewRevenueNeededCr === 3 && w.netNewRevenueTotalCr === 9);
  const w2 = whatItTakes({ ...PLAN, netNewCreditPct: '0.5' }, act(8, 6, 0.2));
  // credited = 2 + 3 = 5; gap 6 credited ÷ 0.5 = 12 net-new.
  check('what-it-takes divides the gap by the net-new weight', w2.creditedGapCr === 6 && w2.netNewRevenueNeededCr === 12);
  const w3 = whatItTakes(PLAN, act(8, 10, 0.2));
  check('what-it-takes: already past target → gap 0', w3.alreadyThere && w3.creditedGapCr === 0);
}
{
  const s1 = nextStepFor(PLAN, act(8, 6, 0.2));
  check('at 8 Cr the next Cr is in slab 1 and pays 1 L', s1.zone === 'slab1' && s1.incrementalPayoutL === 1);
  const s2 = nextStepFor(PLAN, act(8, 8, 0.2));
  check('at 10 Cr the next Cr is in slab 2 and pays 2 L', s2.zone === 'slab2' && s2.incrementalPayoutL === 2);
  const s0 = nextStepFor(PLAN, act(0, 2, 0.2));
  check('below the gate the zone says so', s0.zone === 'below_gate');
  const sc = nextStepFor({ ...PLAN, capEnabled: true, capAmountL: '12' }, act(8, 10, 0.2));
  check('at the cap the next Cr pays nothing and says it is capped', sc.incrementalPayoutL === 0 && sc.cappedOut);
}
{
  check('margin callout: met', marginStatus(PLAN, act(8, 6, 0.2)).kind === 'met');
  const red = marginStatus(PLAN, act(8, 6, 0.18));
  check('margin callout: reduced to 90% of gross', red.kind === 'reduced' && red.payoutPctOfGross === 0.9);
  check('margin callout: nil', marginStatus({ ...PLAN, marginMissTreatment: 'nil' }, act(8, 6, 0.18)).kind === 'nil');
  check('margin callout: not enforced', marginStatus({ ...PLAN, marginMissTreatment: 'ignore' }, act(8, 6, 0.1)).kind === 'not_enforced');
}
{
  const ladder = buildLadder(PLAN, { currentCreditedCr: 8 });
  check('ladder runs gate→slab1Upper+5 steps: 5..15 = 11 rows', ladder.length === 11 && ladder[0]!.creditedRevenueCr === 5 && ladder[10]!.creditedRevenueCr === 15);
  const cur = ladder.filter((r) => r.isCurrent);
  check('exactly one ladder row is current, and it is 8 Cr', cur.length === 1 && cur[0]!.creditedRevenueCr === 8);
  const r11 = ladder.find((r) => r.creditedRevenueCr === 11);
  check('ladder at 11 Cr pays 10 L (= the reverse calc)', r11?.finalPayoutL === 10);
  const between = buildLadder(PLAN, { currentCreditedCr: '8.7' });
  check('8.7 Cr highlights the 8 Cr row', between.find((r) => r.isCurrent)?.creditedRevenueCr === 8);
  const under = buildLadder(PLAN, { currentCreditedCr: 2 });
  check('below the gate no row is highlighted', !under.some((r) => r.isCurrent));
  const odd = buildLadder({ ...PLAN, slab1UpperCr: '9.5' });
  check('a non-step slab1Upper still gets its own ladder row', odd.some((r) => r.creditedRevenueCr === 9.5));
}

/* ------------------------------------------------------------------ *
 * 6. Determinism and exactness                                        *
 * ------------------------------------------------------------------ */
{
  const first = JSON.stringify(calculateIncentive(PLAN, act('8.3333333', '6.1', '0.1789')));
  let same = true;
  for (let i = 0; i < 100; i++) {
    if (JSON.stringify(calculateIncentive(PLAN, act('8.3333333', '6.1', '0.1789'))) !== first) same = false;
  }
  check('100 repeated runs give byte-identical output', same);
  check('exact arithmetic: 0.1 + 0.2 = 0.3', Rational.parse(0.1).add(Rational.parse(0.2)).eq(Rational.parse('0.3')));
  check('string and number inputs agree', JSON.stringify(calculateIncentive(PLAN, act('8', '6', '0.18'))) === JSON.stringify(calculateIncentive(PLAN, act(8, 6, 0.18))));
  check('sumPayoutsL is exact (0.1 + 0.2 = 0.3)', sumPayoutsL([0.1, 0.2]) === 0.3);
  check('Rational.toFixed rounds half away from zero', Rational.parse('2.5').toFixed(0) === '3' && Rational.parse('-2.5').toFixed(0) === '-3');
}

/* ------------------------------------------------------------------ *
 * 7. Seed shapes, hand-checked                                        *
 * ------------------------------------------------------------------ */
{
  const byKey = new Map(SEED_PLAN_SHAPES.map((s) => [s.key, s]));
  const capped = byKey.get('capped')!;
  const nil = byKey.get('margin_nil')!;
  const stepped = byKey.get('full_step')!;
  check('three seed shapes, all valid', SEED_PLAN_SHAPES.length === 3 && SEED_PLAN_SHAPES.every((s) => validatePlanTerms(s.terms).length === 0));

  // capped: target 12, gate 6 / 4 L, slab1 to 12 @1.5, slab2 @3, cap 18.
  // actuals 10 prior + 14 net-new, 22% → credited 2.5 + 14 = 16.5
  // gross = 4 + 6×1.5 + 4.5×3 = 4 + 9 + 13.5 = 26.5 → capped at 18.
  const rc = calculateIncentive(capped.terms, capped.actuals);
  check('seed "capped" → credited 16.5, gross 26.5, capped to 18', rc.creditedRevenue === 16.5 && rc.grossIncentive === 26.5 && rc.finalPayoutL === 18, JSON.stringify(rc));

  // margin_nil: workbook rules, nil treatment; 6 prior + 7 net-new at 17%
  // → credited 8.5, gross 3 + 3.5 = 6.5, margin below 20% → 0.
  const rn = calculateIncentive(nil.terms, nil.actuals);
  check('seed "margin_nil" → credited 8.5, gross 6.5, payout 0', rn.creditedRevenue === 8.5 && rn.grossIncentive === 6.5 && rn.finalPayoutL === 0, JSON.stringify(rn));

  // full_step: gate 4 / 2 L, slab1 to 8 @1, slab2 @2, step 1, full steps only;
  // 4 prior + 8.4 net-new at 21% → credited 1 + 8.4 = 9.4
  // slab1 = floor(4)=4 → 4; slab2 = floor(1.4)=1 → 2; gross 2+4+2 = 8.
  const rs = calculateIncentive(stepped.terms, stepped.actuals);
  check('seed "full_step" → credited 9.4, s1 4, s2 2, payout 8', rs.creditedRevenue === 9.4 && rs.slab1Incentive === 4 && rs.slab2Incentive === 2 && rs.finalPayoutL === 8, JSON.stringify(rs));
}

/* ------------------------------------------------------------------ *
 * 8. Access rule                                                      *
 * ------------------------------------------------------------------ */
{
  const plan = { userId: 'spoc-a' };
  check('a SPOC can read their own plan', canViewIncentivePlan({ userId: 'spoc-a', role: 'member' }, plan));
  check('a SPOC cannot read another SPOC’s plan', !canViewIncentivePlan({ userId: 'spoc-b', role: 'member' }, plan));
  check('a viewer cannot read another’s plan', !canViewIncentivePlan({ userId: 'x', role: 'viewer' }, plan));
  check('a manager can read the team’s plans', canViewIncentivePlan({ userId: 'm', role: 'manager' }, plan));
  check('an admin can read the team’s plans', canViewIncentivePlan({ userId: 'a', role: 'admin' }, plan));
  check('no role → no access', !canViewIncentivePlan({ userId: 'spoc-b', role: null }, plan));
  check('a SPOC may enter their own manual actuals', canEnterManualActuals({ userId: 'spoc-a', role: 'member' }, plan));
  check('a manager may NOT enter someone else’s actuals', !canEnterManualActuals({ userId: 'm', role: 'manager' }, plan));
  check('an admin may enter anyone’s actuals', canEnterManualActuals({ userId: 'a', role: 'admin' }, plan));
}

/* ------------------------------------------------------------------ *
 * 9. Versioning diff, bulk preview, roll-up                           *
 * ------------------------------------------------------------------ */
{
  const d = diffTerms(PLAN, { ...PLAN, slab2RateL: '2.5' });
  check('diffTerms reports exactly the changed field', Object.keys(d).length === 1 && d.slab2RateL?.from === '2' && d.slab2RateL?.to === '2.5');
  check('diffTerms treats 2 and "2.00" as unchanged', Object.keys(diffTerms(PLAN, { ...PLAN, slab2RateL: '2.00' })).length === 0);
}
{
  // Hand-computed: prior 8 / net-new 10 → credited 12, 2 Cr in slab 2.
  // slab2 2 → 2.5 adds 2 × 0.5 = 1 L: payout 12 → 13.
  const rows = [
    { planId: 'p1', userId: 'u1', terms: PLAN, actuals: act(8, 10, 0.2) },
    { planId: 'p2', userId: 'u2', terms: PLAN, actuals: act(8, 6, 0.2) },
  ];
  const preview = previewBulkChange(rows, { slab2RateL: '2.5' });
  const p1 = preview.rows.find((r) => r.planId === 'p1')!;
  const p2 = preview.rows.find((r) => r.planId === 'p2')!;
  check('bulk preview: slab2 2→2.5 moves the 12 Cr resource 12 → 13 L', p1.beforeL === 12 && p1.afterL === 13 && p1.deltaL === 1);
  check('bulk preview: a resource not in slab 2 is unchanged', p2.deltaL === 0);
  check('bulk preview total delta = 1', preview.totalDeltaL === 1);
  check('applyBulkChange only touches the named fields', applyBulkChange(PLAN, { slab2RateL: '2.5' }).slab1RateL === PLAN.slab1RateL);
  check(
    'bulk preview rejects a change that makes plans invalid',
    previewBulkChange(rows, { stepCr: '0' }).rows.every((r) => r.error !== null),
  );
}
{
  const roll = buildRollup([
    { planId: 'a', userId: 'a', displayName: 'A', status: 'active', terms: PLAN, actuals: act(8, 6, 0.2) }, // 6
    { planId: 'b', userId: 'b', displayName: 'B', status: 'active', terms: PLAN, actuals: act(0, 3, 0.2) }, // below gate, 0
    { planId: 'c', userId: 'c', displayName: 'C', status: 'active', terms: PLAN, actuals: act(8, 6, 0.18) }, // margin miss, 5.4
    { planId: 'd', userId: 'd', displayName: 'D', status: 'active', terms: PLAN, actuals: act(8, 10, 0.2) }, // breach, 12
    { planId: 'e', userId: 'e', displayName: 'E', status: 'active', terms: PLAN, actuals: null }, // no actuals
  ], { budgetL: '30' });
  check('roll-up total = 6 + 0 + 5.4 + 12 = 23.4', roll.totals.projectedPayoutL === 23.4, String(roll.totals.projectedPayoutL));
  check('roll-up total equals the sum of its rows', roll.totals.projectedPayoutL === sumPayoutsL(roll.rows.map((r) => r.result?.finalPayoutL ?? 0)));
  check('roll-up flags the below-gate resource', roll.rows.find((r) => r.planId === 'b')!.flags?.belowGate === true && roll.totals.belowGate === 1);
  check('roll-up flags the margin miss', roll.rows.find((r) => r.planId === 'c')!.flags?.marginMiss === true && roll.totals.marginMiss === 1);
  check('roll-up flags the breach', roll.rows.find((r) => r.planId === 'd')!.flags?.breach === true && roll.totals.breach === 1);
  check('roll-up counts a plan with no actuals rather than inventing them', roll.totals.missingActuals === 1 && roll.rows.find((r) => r.planId === 'e')!.result === null);
  check('roll-up budget remaining = 30 - 23.4', roll.totals.budgetRemainingL === 6.6);
}

/* ------------------------------------------------------------------ *
 * 10. One code path: no screen re-implements the formula              *
 * ------------------------------------------------------------------ *
 * Guarded at the source level, like selftest-offerings does for its
 * switch: the regression that matters is a component that "just" multiplies
 * a slab rate to show a number, and then disagrees with the engine the day
 * the plan model changes.
 */
{
  const UI_ROOTS = [
    'src/app/dashboard/incentives',
    'src/app/dashboard/my-incentive',
    'src/app/dashboard/settings/incentives',
    'src/app/api/incentives',
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  UI_ROOTS.forEach(walk);
  const ARITH_ON_TERMS = /(?:Number\()?terms\.\w+\)?\s*[-+*/]\s*[\w(]|[-+*/]\s*(?:Number\()?terms\.\w+/;
  const RATE_MATH = /\b(slab1RateL|slab2RateL|gateIncentiveL|priorYearCreditPct|netNewCreditPct|marginFloorPct)\b\s*\)?\s*[*/]/;
  const offenders = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return ARITH_ON_TERMS.test(src) || RATE_MATH.test(src);
  });
  check(
    `no incentive UI/API file does arithmetic on plan terms (${files.length} files scanned)`,
    files.length >= 10 && offenders.length === 0,
    offenders.join(', '),
  );
  const nightly = readFileSync('src/lib/inngest/workflows/incentive-actuals-nightly.ts', 'utf8');
  const actions = readFileSync('src/app/dashboard/incentives/actions.ts', 'utf8');
  check(
    '"Recompute now" runs the nightly job’s own function, not a copy',
    /export async function recomputeTenant/.test(nightly) && /recomputeTenant\(/.test(actions),
  );
}

/* ------------------------------------------------------------------ *
 * Database checks                                                     *
 * ------------------------------------------------------------------ */
async function databaseChecks(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping the database checks.');
    return;
  }
  const { runDatabaseChecks } = await import('./selftest-incentives-db');
  await runDatabaseChecks(check);
}

databaseChecks()
  .catch((err) => {
    check('database checks ran without throwing', false, err instanceof Error ? err.stack : String(err));
  })
  .finally(() => {
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `\n      ${r.detail}` : ''}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(exitCode);
  });
