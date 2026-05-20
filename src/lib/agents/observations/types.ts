/**
 * Canonical observation taxonomy. Adding a new observation type
 * means adding a literal here AND emitting it from the relevant
 * server action. Derivation jobs filter by `observation_type`, so
 * keeping the vocabulary closed prevents drift.
 *
 * Naming convention: `<domain>.<verb>` — mirrors the realtime event
 * taxonomy. The two stay parallel so future "realtime tap" observers
 * can map 1:1 without translation.
 */
export const OBSERVATION_TYPES = [
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'deal.reassigned',
  'task.created',
  'task.completed',
  'task.overdue',
  'email.sent',
  'email.failed',
  'recommendation.surfaced',
  'recommendation.accepted',
  'recommendation.dismissed',
  'recommendation.completed',
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/**
 * Input shape for the synchronous ingestion helper. Designed to be
 * trivial to fill at every call site — most observations only need
 * the type + the entity reference.
 */
export type ObservationInput = {
  observationType: ObservationType;
  /** Polymorphic entity reference. Optional for tenant-wide signals. */
  entityType?: string;
  entityId?: string;
  /** Free-form context. JSON-serializable values only. */
  metadata?: Record<string, unknown>;
  /**
   * RL signal in [-1, 1]. Most observations leave this NULL; fill it
   * only on terminal events (won = +1, lost = -1, partial = ±0.1..0.3).
   */
  outcomeScore?: number;
};
