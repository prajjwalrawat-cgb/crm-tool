/**
 * Pattern taxonomy. v1 ships `followup_timing` only; the other two
 * (`stage_velocity_health`, `email_engagement_to_outcome`) are reserved
 * in the union so the recommendation runner's pattern_source typing
 * is forward-stable.
 *
 * Adding a new pattern type is three steps:
 *   1. Add the literal here
 *   2. Add a `PatternDeriver` implementation in derivers/<name>.ts
 *   3. Register it in `src/lib/agents/patterns/registry.ts`
 *
 * The registry indirection means consumers (recommendation runners,
 * UI cards) never import deriver modules directly — they only know
 * the type name and the data shape.
 */
export const PATTERN_TYPES = [
  'followup_timing',
  'stage_velocity_health',
  'email_engagement_to_outcome',
] as const;
export type PatternType = (typeof PATTERN_TYPES)[number];

/** Confidence thresholds — single source of truth across the system. */
export const PATTERN_THRESHOLDS = {
  /** Below this we treat the finding as noise and don't surface it. */
  NOISE_FLOOR: 0.4,
  INDICATIVE: 0.4,
  STRONG: 0.6,
  HIGH: 0.8,
  /** Minimum number of supporting observations before a pattern is published. */
  MIN_SAMPLE_SIZE: 8,
} as const;

/**
 * v1 pattern data shape for followup_timing. The bucket key encodes
 * the hours-to-followup window; the body captures the observed win
 * rate vs the tenant baseline.
 *
 * Cleanly typed today; tomorrow a model swap can write a richer
 * shape under the same pattern_type but with a different
 * `pattern_data.kind` discriminator.
 */
export type FollowupTimingData = {
  kind: 'followup_timing';
  bucketHours: { from: number; to: number };
  /** Win rate observed in this bucket. */
  winRateBucket: number;
  /** Baseline win rate for the tenant in the same window. */
  winRateBaseline: number;
  /** delta = winRateBucket - winRateBaseline. Drives the boost calc. */
  scoreDelta: number;
  /** Sample size for this bucket only (`< supporting_sample_size`). */
  bucketSampleSize: number;
};

export type PatternData = FollowupTimingData;

/** Boosting input — what the recommendation runner shows on a card. */
export type PatternMatch = {
  patternId: string;
  patternType: PatternType;
  patternKey: string;
  confidence: number;
  sampleSize: number;
  /** Boost multiplier applied to the heuristic score. Always > 0. */
  effectiveBoost: number;
  /** Short human-readable headline for "Why am I seeing this?" */
  headline: string;
  /** Optional body string with the supporting number. */
  detail?: string;
};
