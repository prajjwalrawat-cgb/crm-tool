import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

import type { DealRiskSignals } from '../src/lib/deals/risk/score';

/**
 * Self-test for the Phase 1 deal risk layer.
 *
 * Four things worth asserting, and none of them is the rendering:
 *
 *   1. THE RUBRIC IS WHAT IT CLAIMS. The five group maxima sum to 100, no
 *      group can exceed its own maximum, and the score is exactly the sum of
 *      the factors shown to the user. A score that does not equal its own
 *      breakdown is worse than no breakdown.
 *
 *   2. THE PROMPT LEAKS NO EXACT FIGURES. The payload sent to Claude speaks
 *      in bands, which is what lets one generated sentence stay true for
 *      weeks and what makes an exact number in the output detectable as an
 *      invention. If a raw day-count ever reaches the payload, both
 *      properties are gone.
 *
 *   3. THE STORED SCORE MATCHES THE RUBRIC. Every row written by the nightly
 *      job is recomputed in JS from its own stored signals and must agree.
 *
 *   4. NOTHING THE MODEL WROTE IS UNGROUNDED. Every stored explanation is
 *      re-checked against the payload its hash was computed over — the
 *      automated form of "spot-check 10 deals for hallucinated factors",
 *      run over all of them, every time.
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const CLEAN: DealRiskSignals = {
  stage: 'proposal',
  pushCount: 0,
  totalSlipDays: 0,
  daysSinceLastTouch: 1,
  completenessFilled: 10,
  completenessApplicable: 10,
  timeInStageDays: 3,
  stageMedianDays: 21,
  dealAgeDays: 20,
  avgCycleDays: 90,
};

const WORST: DealRiskSignals = {
  stage: 'negotiation',
  pushCount: 6,
  totalSlipDays: 120,
  daysSinceLastTouch: 200,
  completenessFilled: 0,
  completenessApplicable: 11,
  timeInStageDays: 300,
  stageMedianDays: 20,
  dealAgeDays: 400,
  avgCycleDays: 90,
};

async function main() {
  const {
    RISK_ELEVATED_FROM,
    RISK_HIGH_FROM,
    RISK_MAX,
    RISK_WEIGHTS,
    MIN_MEANINGFUL_STAGE_MEDIAN_DAYS,
    bandForRisk,
    computeDealRisk,
    deterministicExplanation,
  } = await import('../src/lib/deals/risk/score');
  const { hashPayload, riskPromptPayload, signalsHash } = await import(
    '../src/lib/deals/risk/hash'
  );
  const { isGrounded } = await import('../src/lib/deals/risk/explain');

  /* ---------- 1: the rubric ---------- */

  check(
    'the five group maxima sum to exactly 100',
    RISK_MAX === 100,
    `${RISK_MAX}`,
  );

  const clean = computeDealRisk(CLEAN);
  check(
    'a deal with nothing wrong scores 0 and reports no factors',
    clean.score === 0 && clean.factors.length === 0 && clean.band === 'low',
    `${clean.score} / ${clean.factors.length} factors`,
  );

  const worst = computeDealRisk(WORST);
  check(
    'a deal with every signal at its worst scores exactly 100',
    worst.score === 100 && worst.band === 'high',
    `${worst.score}`,
  );
  check(
    'no factor group can exceed its own documented maximum',
    worst.factors.every((f) => {
      const max =
        f.key === 'pushback'
          ? RISK_WEIGHTS.pushback
          : f.key === 'silence'
            ? RISK_WEIGHTS.silence
            : f.key === 'completeness'
              ? RISK_WEIGHTS.completeness
              : f.key === 'time_in_stage'
                ? RISK_WEIGHTS.timeInStage
                : RISK_WEIGHTS.age;
      return f.points <= max;
    }),
    worst.factors.map((f) => `${f.key}=${f.points}`).join(' '),
  );
  check(
    'the score is exactly the sum of the factors the user is shown',
    // 6 pushes + 120 slip days would be 34 before the group cap; the cap is
    // what makes the breakdown add up to the number beside it.
    worst.factors.reduce((n, f) => n + f.points, 0) === worst.score,
  );
  check(
    'factors come back heaviest first',
    worst.factors.every(
      (f, i) => i === 0 || worst.factors[i - 1].points >= f.points,
    ),
  );
  check(
    'band boundaries are exclusive at the documented cut points',
    bandForRisk(RISK_HIGH_FROM) === 'high' &&
      bandForRisk(RISK_HIGH_FROM - 1) === 'elevated' &&
      bandForRisk(RISK_ELEVATED_FROM) === 'elevated' &&
      bandForRisk(RISK_ELEVATED_FROM - 1) === 'low',
  );

  // The live-data fix: a workspace whose median time in stage is a day or two
  // (bulk-imported history) must not have every deal charged 15 points.
  const tinyMedian = computeDealRisk({
    ...CLEAN,
    timeInStageDays: 45,
    stageMedianDays: 2,
  });
  const realMedian = computeDealRisk({
    ...CLEAN,
    timeInStageDays: 45,
    stageMedianDays: MIN_MEANINGFUL_STAGE_MEDIAN_DAYS,
  });
  check(
    'the time-in-stage factor abstains when the workspace median is too small to mean anything',
    !tinyMedian.factors.some((f) => f.key === 'time_in_stage') &&
      realMedian.factors.some((f) => f.key === 'time_in_stage'),
    `tiny=${tinyMedian.score} real=${realMedian.score}`,
  );

  check(
    'an unknown last-touch scores zero rather than worst-case',
    computeDealRisk({ ...CLEAN, daysSinceLastTouch: null }).factors.every(
      (f) => f.key !== 'silence',
    ),
  );
  check(
    'a deal that owes no fields is not scored on completeness',
    computeDealRisk({
      ...CLEAN,
      completenessApplicable: 0,
      completenessFilled: 0,
    }).factors.every((f) => f.key !== 'completeness'),
  );
  check(
    'the deterministic sentence names the heaviest factors',
    deterministicExplanation(worst).includes(worst.factors[0].detail),
    deterministicExplanation(worst),
  );

  /* ---------- 2: the prompt payload ---------- */

  const quiet19 = { ...CLEAN, daysSinceLastTouch: 19 };
  const quiet25 = { ...CLEAN, daysSinceLastTouch: 25 };
  const payload19 = riskPromptPayload(quiet19, computeDealRisk(quiet19));

  check(
    'the payload speaks in bands and never carries the exact day count',
    !JSON.stringify(payload19).includes('19') &&
      payload19.signals.some((sig) => sig.includes('two to four weeks')),
    JSON.stringify(payload19.signals),
  );
  check(
    'two days inside one band produce the same prompt, so no second API call',
    signalsHash(quiet19, computeDealRisk(quiet19)) ===
      signalsHash(quiet25, computeDealRisk(quiet25)),
  );
  const quiet40 = { ...CLEAN, daysSinceLastTouch: 40 };
  check(
    'crossing a band changes the prompt, so the sentence is regenerated',
    signalsHash(quiet19, computeDealRisk(quiet19)) !==
      signalsHash(quiet40, computeDealRisk(quiet40)),
  );
  check(
    'a deal with no risk signals produces an empty signal list (never explained)',
    riskPromptPayload(CLEAN, clean).signals.length === 0,
  );
  check(
    'the hash is a pure function of the payload',
    hashPayload(payload19) === hashPayload(riskPromptPayload(quiet19, computeDealRisk(quiet19))),
  );

  /* ---------- grounding ---------- */

  const pushed = {
    ...CLEAN,
    pushCount: 2,
    daysSinceLastTouch: 19,
    completenessFilled: 8,
    completenessApplicable: 11,
  };
  const pushedPayload = riskPromptPayload(pushed, computeDealRisk(pushed));
  check(
    'a sentence built only from payload facts passes the grounding check',
    isGrounded(
      'Pushed 2 times, untouched for two to four weeks, and 3 required fields still empty at proposal stage.',
      pushedPayload,
    ),
  );
  check(
    'a sentence inventing a specific day count is rejected',
    !isGrounded(
      'No activity in 19 days and the champion has gone quiet.',
      pushedPayload,
    ),
  );
  check(
    'a sentence inventing a larger figure is rejected',
    !isGrounded('Pushed 7 times since April.', pushedPayload),
  );
  check(
    'word-numbers from the band phrases themselves are fine',
    isGrounded(
      'Pushed twice and untouched for two to four weeks.',
      pushedPayload,
    ),
  );

  /* ---------- 3 + 4: against the rows the job actually wrote ---------- */

  const { db, client } = await import('../src/db/index');

  const rows = (await db.execute(sql`
    SELECT t.name AS tenant, r.deal_id, r.score, r.band, r.factors, r.signals,
           r.explanation, r.signals_hash, d.stage::text AS stage, d.deleted_at
    FROM deal_risk_scores r
    JOIN tenants t ON t.id = r.tenant_id
    JOIN deals d ON d.id = r.deal_id
  `)) as unknown as Array<{
    tenant: string;
    deal_id: string;
    score: number;
    band: string;
    factors: Array<{ key: string; points: number }>;
    signals: Record<string, number | string | null>;
    explanation: string | null;
    signals_hash: string;
    stage: string;
    deleted_at: string | null;
  }>;

  let recomputed = 0;
  let mismatched = 0;
  let explanationsChecked = 0;
  let ungrounded = 0;
  let staleHashes = 0;
  let closedScored = 0;

  for (const row of rows) {
    if (row.deleted_at != null || ['won', 'lost', 'hold'].includes(row.stage)) {
      closedScored += 1;
    }

    const s = row.signals;
    if (typeof s?.stage !== 'string') continue;
    const signals: DealRiskSignals = {
      stage: s.stage as DealRiskSignals['stage'],
      pushCount: Number(s.pushCount ?? 0),
      totalSlipDays: Number(s.totalSlipDays ?? 0),
      daysSinceLastTouch:
        s.daysSinceLastTouch == null ? null : Number(s.daysSinceLastTouch),
      completenessFilled: Number(s.completenessFilled ?? 0),
      completenessApplicable: Number(s.completenessApplicable ?? 0),
      timeInStageDays: Number(s.timeInStageDays ?? 0),
      stageMedianDays: Number(s.stageMedianDays ?? 0),
      dealAgeDays: Number(s.dealAgeDays ?? 0),
      avgCycleDays: Number(s.avgCycleDays ?? 0),
    };
    const result = computeDealRisk(signals);
    recomputed += 1;
    if (result.score !== Number(row.score) || result.band !== row.band) {
      mismatched += 1;
    }

    const payload = riskPromptPayload(signals, result);
    if (hashPayload(payload) !== row.signals_hash) staleHashes += 1;

    if (row.explanation) {
      explanationsChecked += 1;
      if (!isGrounded(row.explanation, payload)) ungrounded += 1;
    }
  }

  check(
    'every stored score is reproducible from its own stored signals',
    recomputed > 0 && mismatched === 0,
    `${recomputed} rows recomputed, ${mismatched} disagreed`,
  );
  check(
    'every stored hash matches the payload its signals produce',
    staleHashes === 0,
    `${staleHashes} stale`,
  );
  check(
    'no won, lost, held or deleted deal carries a risk row',
    closedScored === 0,
    `${closedScored} rows on non-open deals`,
  );
  check(
    'every stored factor list adds up to its stored score',
    rows.every(
      (r) =>
        (r.factors ?? []).reduce((n, f) => n + Number(f.points), 0) ===
        Number(r.score),
    ),
  );
  check(
    explanationsChecked > 0
      ? 'every generated explanation is grounded in the payload it was given'
      : 'no generated explanations to check (no ANTHROPIC_API_KEY configured)',
    ungrounded === 0,
    `${explanationsChecked} checked, ${ungrounded} ungrounded`,
  );

  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  — ${r.detail}` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed ` +
      `(${rows.length} stored rows, ${explanationsChecked} explanations checked)`,
  );

  await client.end?.();
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
