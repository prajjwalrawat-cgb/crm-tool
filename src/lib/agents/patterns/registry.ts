import 'server-only';

import { deriveFollowupTimingPatterns } from './derivers/followup-timing';
import type { PatternType } from './types';

/**
 * Pattern registry. Maps a `pattern_type` to its derivation function.
 *
 * A `PatternDeriver` reads its own slice of `agent_observations` for
 * the tenant + time window, runs whatever statistic it needs, and
 * UPSERTs results into `agent_patterns`. It returns a count summary
 * for ops visibility.
 *
 * Consumers (the nightly Inngest job, ad-hoc admin tooling) walk
 * this map — they don't import individual derivers. That keeps the
 * "which deriver runs?" decision in one place and means swapping a
 * SQL-based deriver for an ML-based one is a one-line registry
 * edit.
 *
 * v1 ships followup_timing only. The other two are reserved literal
 * types in `PatternType` so the recommendation runner's typing
 * tracks the eventual menu.
 */

export type DerivationStats = {
  patternType: PatternType;
  observed: number;
  patternsWritten: number;
  patternsSkipped: number;
  durationMs: number;
};

export type PatternDeriver = (input: {
  tenantId: string;
  /** ISO start of the window to consider. */
  windowFromIso: string;
  /** ISO end (exclusive) of the window. Usually NOW. */
  windowToIso: string;
}) => Promise<DerivationStats>;

const REGISTRY: Partial<Record<PatternType, PatternDeriver>> = {
  followup_timing: deriveFollowupTimingPatterns,
  // stage_velocity_health: reserved
  // email_engagement_to_outcome: reserved
};

export function getDeriverFor(
  patternType: PatternType,
): PatternDeriver | null {
  return REGISTRY[patternType] ?? null;
}

/** All pattern types that have a published deriver right now. */
export function listEnabledPatternTypes(): PatternType[] {
  return Object.keys(REGISTRY) as PatternType[];
}
