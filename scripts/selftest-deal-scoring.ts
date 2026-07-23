/**
 * Unit self-test for Module 2's pure scoring function `computeDealScore`.
 * No DB — the function is dependency-free, so this runs standalone:
 *   pnpm tsx scripts/selftest-deal-scoring.ts
 *
 * Asserts determinism, the band thresholds, that reasons explain every point
 * of deviation from 50, and ≥6 fixture scenarios incl. brand-new / dead /
 * perfect deals.
 */

import {
  bandForScore,
  computeDealScore,
  type DealScoreContext,
} from '../src/lib/deals/scoring/compute';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const NOW = new Date('2026-07-23T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const isoInDays = (n: number) => {
  const d = new Date(
    Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const base: DealScoreContext = {
  now: NOW,
  stage: 'qualified',
  lastGenuineActivityAt: null,
  timeInStageDays: 0,
  stageMedianDays: 14,
  expectedCloseDate: null,
  stakeholderCount: 0,
  nextStep: null,
  openTaskCount: 0,
  overdueTaskCount: 0,
  amountMinor: 0,
};

/* 1. Brand-new deal: no activity(-25), on-pace(+10), amount 0(-15) => 20 */
{
  const r = computeDealScore({ ...base });
  check('brand-new deal = 20 (at_risk)', r.score === 20 && r.band === 'at_risk', `score=${r.score}`);
}

/* 2. Dead deal: stale(-20), stalled(-15), overdue close(-20), overdue task(-10), amount0(-15) => clamp 0 */
{
  const r = computeDealScore({
    ...base,
    lastGenuineActivityAt: daysAgo(30),
    timeInStageDays: 60,
    stageMedianDays: 14,
    expectedCloseDate: isoInDays(-10),
    overdueTaskCount: 1,
  });
  check('dead deal clamps to 0', r.score === 0 && r.band === 'at_risk', `score=${r.score}`);
}

/* 3. Perfect deal: recent(+15), on-pace(+10), imminent close(+10), stakeholders(+10),
      next step(+5), open tasks(+5) => 105 clamp 100 strong */
{
  const r = computeDealScore({
    ...base,
    stage: 'proposal',
    lastGenuineActivityAt: daysAgo(1),
    timeInStageDays: 5,
    stageMedianDays: 21,
    expectedCloseDate: isoInDays(20),
    stakeholderCount: 2,
    nextStep: 'Send MSA',
    openTaskCount: 2,
    amountMinor: 500000,
  });
  check('perfect deal clamps to 100 (strong)', r.score === 100 && r.band === 'strong', `score=${r.score}`);
}

/* 4. Moderate: activity 10d(+5), stakeholders(+10), amount set => 65 moderate */
{
  const r = computeDealScore({
    ...base,
    lastGenuineActivityAt: daysAgo(10),
    timeInStageDays: 20, // >14 but not >28 → neutral
    stageMedianDays: 14,
    stakeholderCount: 1,
    amountMinor: 100000,
  });
  check('moderate deal = 65', r.score === 65 && r.band === 'moderate', `score=${r.score}`);
}

/* 5. Determinism */
{
  const ctx = { ...base, lastGenuineActivityAt: daysAgo(3), amountMinor: 1000 };
  const a = computeDealScore(ctx);
  const b = computeDealScore(ctx);
  check('deterministic', JSON.stringify(a) === JSON.stringify(b));
}

/* 6. Reasons explain every point of deviation (unclamped case) */
{
  const r = computeDealScore({
    ...base,
    lastGenuineActivityAt: daysAgo(10), // +5
    timeInStageDays: 5, // +10
    stakeholderCount: 1, // +10
    amountMinor: 100000,
  });
  const sum = r.reasons.reduce((s, x) => s + x.delta, 0);
  check('reasons sum reconciles score', 50 + sum === r.score, `50+${sum} vs ${r.score}`);
}

/* 7. No activity ever emits the -25 reason */
{
  const r = computeDealScore({ ...base, amountMinor: 100000, timeInStageDays: 100, stageMedianDays: 14 });
  const hasNone = r.reasons.some((x) => x.signal === 'activity_none' && x.delta === -25);
  const hasStalled = r.reasons.some((x) => x.signal === 'stage_stalled');
  check('no-activity + stalled reasons present', hasNone && hasStalled);
}

/* 8. Band thresholds exact */
{
  check('band 70 = strong', bandForScore(70) === 'strong');
  check('band 69 = moderate', bandForScore(69) === 'moderate');
  check('band 40 = moderate', bandForScore(40) === 'moderate');
  check('band 39 = at_risk', bandForScore(39) === 'at_risk');
}

console.log('\n─── Deal-scoring unit self-test ───');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
process.exit(exitCode);
