/**
 * Module 6 — Hold parking state vocabulary. Pure/shared (client + server).
 */

export const HOLD_REASONS = [
  'budget_deferred',
  'champion_left',
  'timing',
  'competitor_evaluation',
  'client_unresponsive',
  'other',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const HOLD_REASON_LABELS: Record<HoldReason, string> = {
  budget_deferred: 'Budget deferred',
  champion_left: 'Champion left',
  timing: 'Timing',
  competitor_evaluation: 'Evaluating competitor',
  client_unresponsive: 'Client unresponsive',
  other: 'Other',
};

export function isHoldReason(v: unknown): v is HoldReason {
  return typeof v === 'string' && (HOLD_REASONS as readonly string[]).includes(v);
}
