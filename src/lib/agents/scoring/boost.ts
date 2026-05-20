import 'server-only';

import type { AgentPattern } from '@/db/schema';

import {
  type FollowupTimingData,
  type PatternMatch,
} from '../patterns/types';

/**
 * Recommendation V2 scoring. Hybrid: heuristic baseline × bounded
 * learned-pattern boost.
 *
 *   score = heuristic_score × (1 + min(0.35, Σ pattern.delta × pattern.confidence))
 *
 * Hard cap of +35% across all matching patterns. Reason: learned
 * patterns are statistical signals, not ground truth. Letting them
 * dominate the score would mean a single noisy correlation could
 * push a bad candidate to the top. With a +35% ceiling the heuristic
 * still drives ranking; learning only re-orders close ties.
 *
 * Returns the final score AND the matches that contributed — the UI
 * card uses the matches list to render "Why am I seeing this?".
 */
export const MAX_LEARNED_BOOST = 0.35;

export type ScoringContext = {
  /** When the candidate is a deal: hours since the deal was created. */
  hoursSinceCreated?: number;
  /** When the candidate is a deal: hours since the first follow-up. */
  hoursToFirstFollowup?: number | null;
};

export type BoostResult = {
  /** Final score = heuristicScore × (1 + cappedBoost). */
  finalScore: number;
  /** Heuristic score the caller passed in. */
  heuristicScore: number;
  /** Sum of all per-pattern contributions (pre-cap). */
  rawBoost: number;
  /** Same value clamped to [-MAX_LEARNED_BOOST, MAX_LEARNED_BOOST]. */
  cappedBoost: number;
  /** Patterns that contributed — surface these in the UI. */
  matches: PatternMatch[];
};

/**
 * Apply learned-pattern boosts to a single candidate's heuristic
 * score. `patterns` is the full pattern set for the tenant + type;
 * the function picks the ones that match this candidate via the
 * context.
 */
export function applyLearnedBoost(args: {
  heuristicScore: number;
  patterns: AgentPattern[];
  context: ScoringContext;
}): BoostResult {
  const matches: PatternMatch[] = [];
  let rawBoost = 0;

  for (const p of args.patterns) {
    const match = matchPatternToCandidate(p, args.context);
    if (!match) continue;
    matches.push(match);
    rawBoost += match.effectiveBoost;
  }

  const cappedBoost = Math.max(-MAX_LEARNED_BOOST, Math.min(MAX_LEARNED_BOOST, rawBoost));

  return {
    finalScore: args.heuristicScore * (1 + cappedBoost),
    heuristicScore: args.heuristicScore,
    rawBoost,
    cappedBoost,
    matches,
  };
}

/**
 * Per-pattern matcher. Returns the boost contribution and the
 * "why" payload for the UI. Returns `null` when the pattern doesn't
 * apply to this candidate.
 *
 * Today only one pattern type is published (`followup_timing`) so
 * the function is a single branch; as derivers come online the
 * switch picks up new cases.
 */
function matchPatternToCandidate(
  pattern: AgentPattern,
  context: ScoringContext,
): PatternMatch | null {
  const data = pattern.patternData as unknown as { kind?: string };
  if (data?.kind === 'followup_timing') {
    return matchFollowupTiming(pattern, data as FollowupTimingData, context);
  }
  return null;
}

function matchFollowupTiming(
  pattern: AgentPattern,
  data: FollowupTimingData,
  context: ScoringContext,
): PatternMatch | null {
  // The pattern fires when the candidate is a deal we could
  // *encourage to follow up sooner*. Apply only when the candidate's
  // existing follow-up gap matches the bucket OR no follow-up
  // happened yet AND we want the rep to land inside the bucket.
  const hours = context.hoursToFirstFollowup;
  const insideBucket =
    typeof hours === 'number' &&
    hours >= data.bucketHours.from &&
    hours < data.bucketHours.to;
  // Encourage early-bucket follow-ups for deals that haven't had one.
  const encourageEarly =
    hours === null &&
    data.bucketHours.from === 0 &&
    data.scoreDelta > 0;
  if (!insideBucket && !encourageEarly) return null;

  // Effective boost = signed delta × confidence. So a "negative"
  // pattern (late follow-ups close worse) yields a NEGATIVE boost,
  // which the scoring cap handles symmetrically.
  const effectiveBoost = data.scoreDelta * pattern.confidenceScore;

  const winPct = Math.round(data.winRateBucket * 100);
  const baselinePct = Math.round(data.winRateBaseline * 100);
  const deltaPct = Math.round(data.scoreDelta * 100);
  const sign = deltaPct >= 0 ? '+' : '−';

  return {
    patternId: pattern.id,
    patternType: 'followup_timing',
    patternKey: pattern.patternKey,
    confidence: pattern.confidenceScore,
    sampleSize: pattern.supportingSampleSize,
    effectiveBoost,
    headline: `Follow-up in ${data.bucketHours.from}-${data.bucketHours.to}h ${
      data.scoreDelta >= 0 ? 'wins' : 'loses'
    } ${Math.abs(deltaPct)}% vs baseline`,
    detail: `${winPct}% win rate in this bucket vs ${baselinePct}% baseline (${sign}${Math.abs(
      deltaPct,
    )}pp, n=${data.bucketSampleSize}).`,
  };
}
