/**
 * Public types for the predictive intelligence layer. Client-safe (no
 * `server-only` import) so UI cards can consume the shapes without
 * dragging server modules into the bundle.
 *
 * v1 is heuristic-only — no ML, no embeddings. The shapes here are
 * forward-compatible with future model-derived predictions; a swap
 * just changes the computation, not the consumer surface.
 */

export const PREDICTION_KINDS = [
  /** Likelihood the deal closes in its expected window. 0..1. */
  'close_probability',
  /** Whether the deal's signal is trending up or down. 0..1 directional. */
  'deal_momentum',
  /** Likelihood the deal becomes stale before close. 0..1. */
  'stale_risk',
  /** Likelihood the thread goes silent before resolution. 0..1. */
  'comm_risk',
] as const;
export type PredictionKind = (typeof PREDICTION_KINDS)[number];

export type PredictionTrend = 'up' | 'down' | 'flat';

/**
 * Discrete signal codes a prediction can carry. Keeping the vocabulary
 * closed lets the UI render each signal as a typed chip with an icon
 * + tooltip — open strings would dilute the explanation chrome.
 */
export const PREDICTION_SIGNALS = [
  'recent_stage_advance',
  'recent_stage_regression',
  'high_email_engagement',
  'low_email_engagement',
  'frequent_activity',
  'sparse_activity',
  'long_silence',
  'multiple_failed_sends',
  'overdue_tasks',
  'low_probability_high_value',
  'short_window_to_close',
  'aging_open_deal',
] as const;
export type PredictionSignal = (typeof PREDICTION_SIGNALS)[number];

export type Prediction = {
  kind: PredictionKind;
  entityType: 'deal' | 'thread' | 'contact' | 'company';
  entityId: string;
  /** Display name for the entity (deal name / subject). */
  entityName: string;
  /** Current value, 0..1. Semantics vary by kind — see PREDICTION_KINDS. */
  value: number;
  /** Trend direction since the previous compute (v1 always 'flat' until we cache). */
  trend: PredictionTrend;
  /** Confidence 0..1. < 0.4 = treat as noise; we filter at surface time. */
  confidence: number;
  /** Discrete signal codes that contributed. Sorted by recency desc. */
  signals: PredictionSignal[];
  /** Short human-readable explanation, ≤ 200 chars. */
  explanation: string;
  /** Optional supporting metrics surfaced under the chip. */
  supporting?: Array<{ label: string; value: string }>;
};

export const PREDICTION_NOISE_FLOOR = 0.4;
