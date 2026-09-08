import { createHash } from 'node:crypto';

import type { DealRiskSignals, RiskResult } from './score';

/**
 * THE EXPLANATION CACHE KEY — and the payload the model is actually shown.
 *
 * These two things are one thing on purpose. The hash is computed over
 * exactly the object sent to Claude, so the cache rule becomes trivially
 * correct: identical prompt, identical answer, no call. Nothing can drift
 * between "what we asked" and "what we think we asked".
 *
 * ---------------------------------------------------------------
 * WHY THE PAYLOAD IS BUCKETED RATHER THAN EXACT
 * ---------------------------------------------------------------
 * The obvious payload is the raw signals — "no activity in 12 days". It is
 * also the expensive one: that number changes every single night on every
 * stagnant deal, so the hash changes every night, so every deal with any risk
 * factor is re-explained daily. On a 300-deal workspace that is a few hundred
 * API calls a day to rewrite sentences that mean the same thing.
 *
 * Worse, it drifts. If the hash instead ignored the exact number, yesterday's
 * sentence would keep saying "12 days" while the factor chip beside it said
 * 20 — one card contradicting itself.
 *
 * So the model never sees the exact number. It sees the BAND: "2-4 weeks
 * since any change". The bands are the same thresholds the rubric scores on,
 * so the prompt changes precisely when the score changes and never otherwise.
 * The exact figures live in the factor chips, which are recomputed nightly and
 * are always current. Both halves of the card are true, and neither can go
 * stale against the other.
 */

/** The compact, bucketed view of a deal's risk that the model is shown. */
export type RiskPromptPayload = {
  stage: string;
  score: number;
  band: string;
  /** Bucketed signal phrases, only for factors that actually scored. */
  signals: string[];
};

/** Thresholds mirrored from `computeDealRisk`. Change both together. */
function silenceBand(days: number): string | null {
  if (days >= 60) return 'no change in over two months';
  if (days >= 30) return 'no change in one to two months';
  if (days >= 14) return 'no change in two to four weeks';
  if (days >= 8) return 'no change in one to two weeks';
  return null;
}

function ratioBand(ratio: number, unit: string): string | null {
  if (ratio > 2) return `more than twice the ${unit}`;
  if (ratio > 1.5) return `about twice the ${unit}`;
  if (ratio > 1) return `slightly over the ${unit}`;
  return null;
}

/**
 * Build the payload. Only factors that scored contribute a phrase — a deal is
 * never described by what is fine about it, because the sentence is a risk
 * explanation and listing non-problems would bury the two that matter.
 */
export function riskPromptPayload(
  signals: DealRiskSignals,
  result: RiskResult,
): RiskPromptPayload {
  const scored = new Set(result.factors.map((f) => f.key));
  const out: string[] = [];

  if (scored.has('pushback')) {
    const n = signals.pushCount;
    out.push(
      `close date pushed ${n} ${n === 1 ? 'time' : 'times'}` +
        (signals.totalSlipDays >= 60
          ? ', now over two months later than first committed'
          : signals.totalSlipDays >= 30
            ? ', now over a month later than first committed'
            : ''),
    );
  }
  if (scored.has('silence')) {
    const phrase = silenceBand(signals.daysSinceLastTouch ?? 0);
    if (phrase) out.push(phrase);
  }
  if (scored.has('completeness')) {
    const missing =
      signals.completenessApplicable - signals.completenessFilled;
    out.push(
      `${missing} required ${missing === 1 ? 'field' : 'fields'} still empty at ${signals.stage} stage`,
    );
  }
  if (scored.has('time_in_stage')) {
    const phrase = ratioBand(
      signals.timeInStageDays / Math.max(1, signals.stageMedianDays),
      `workspace median for ${signals.stage}`,
    );
    if (phrase) out.push(`in stage ${phrase}`);
  }
  if (scored.has('age')) {
    const phrase = ratioBand(
      signals.dealAgeDays / Math.max(1, signals.avgCycleDays),
      'average won-deal cycle',
    );
    if (phrase) out.push(`open ${phrase}`);
  }

  return {
    stage: signals.stage,
    score: result.score,
    band: result.band,
    signals: out,
  };
}

/**
 * Stable hash of the payload. Key order is fixed by construction (the object
 * literal above), and the signal array is already in rubric order, so the
 * same deal state always serialises to the same string — the property the
 * whole cache rests on.
 */
export function hashPayload(payload: RiskPromptPayload): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 32);
}

export function signalsHash(
  signals: DealRiskSignals,
  result: RiskResult,
): string {
  return hashPayload(riskPromptPayload(signals, result));
}
