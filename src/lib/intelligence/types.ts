/**
 * Shared types for the intelligence layer. Client-safe (no `server-only`
 * import) so React cards can consume insight types without dragging
 * server code into the bundle.
 */

/**
 * Catalog of insight types the intelligence layer can produce. Adding
 * a new type requires:
 *   1. Appending the literal here
 *   2. Adding the source builder + prompt + parser in src/lib/intelligence/
 *   3. Adding a rendering branch in <AiInsightCard /> (or a sibling card)
 */
export const INSIGHT_TYPES = [
  'daily-exec',
  'deal-summary',
  'risk-flag-set',
  'recommendation-set',
  'pipeline-summary',
  'activity-summary',
  'thread-summary',
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

/**
 * Per-thread AI summary output. Surfaces on the thread detail page +
 * (eventually) the inbox preview row when a thread has unread messages.
 *
 * The shape is deliberately compact: narrative + 3 lists. Anything
 * richer (chart, embedded media) should be a separate insight type,
 * not a bigger thread summary.
 */
export type ThreadAiSummary = {
  /** 2-3 sentence summary of what the thread is about + current state. */
  narrative: string;
  /** Open questions / pending decisions the model spotted. */
  unresolved: string[];
  /** Up to 3 suggested next actions, ordered by priority. */
  nextActions: string[];
  /** Negotiation risks, stalls, or concerns. */
  riskNotes: string[];
  /** Overall sentiment: positive / neutral / negative — drives the chrome tint. */
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
};

/**
 * State a card can be in. Drives the visible badge + skeleton + enable
 * state of the feedback buttons.
 *
 *   generating   — no row yet, regen enqueued
 *   cached       — row present, sourceHash matches → fresh
 *   stale        — row present, sourceHash differs → regen enqueued, showing previous
 *   failed       — most-recent regen recorded ai_invocations.status='error'
 *   mock         — AI in mock mode; content is a deterministic stub
 *   budget       — tenant daily token cap hit; regen refused
 *   disabled     — AI_ENABLED=true but no API key
 */
export const INSIGHT_STATES = [
  'generating',
  'cached',
  'stale',
  'failed',
  'mock',
  'budget',
  'disabled',
] as const;
export type InsightState = (typeof INSIGHT_STATES)[number];

/**
 * Severity rank for a single risk flag. Used to sort the risk feed and
 * color-code the supporting-signals chip. `info` is "noticed but not
 * actionable yet."
 */
export const RISK_SEVERITIES = ['info', 'warning', 'danger'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

/**
 * A single risk flag the model emits. The schema is deliberately small;
 * we want the model to choose from a fixed list of `signal` codes so the
 * UI can pattern-match (icon, link) instead of free-text parsing.
 */
export type RiskFlag = {
  /** Entity the flag is about. `null` entity = tenant-wide flag. */
  entity: { type: 'deal' | 'company' | 'contact'; id: string; name: string } | null;
  severity: RiskSeverity;
  /** Short headline, ≤ 80 chars. */
  title: string;
  /** Why the model thinks so — 1-2 sentences, ≤ 240 chars. */
  reason: string;
  /** Discrete signal codes the model picked from. Helps the UI render chips. */
  signals: SignalCode[];
  /** Model's self-reported confidence 0-1. UI gates display below 0.4. */
  confidence: number;
};

export const SIGNAL_CODES = [
  'no_recent_activity',
  'no_recent_email',
  'no_stage_movement',
  'overdue_followup',
  'low_probability_high_value',
  'inactive_owner',
  'workflow_failure',
  'email_delivery_failure',
  'stalled_at_stage',
] as const;
export type SignalCode = (typeof SIGNAL_CODES)[number];

/**
 * Single recommendation the model emits. Each has an `actionKind` so
 * the UI can route a click directly to the right composer / drawer.
 *
 * `patternSource` is filled by the recommendation runner AFTER the
 * model returns: matched learned patterns are attached so the UI can
 * render "Why am I seeing this?". The model itself doesn't see the
 * patterns — we keep prompt + boost concerns separated.
 */
export type Recommendation = {
  /** Entity the recommendation is about. Required — actionable recos are entity-scoped. */
  entity: { type: 'deal' | 'company' | 'contact' | 'task'; id: string; name: string };
  /** Short headline, ≤ 80 chars. */
  title: string;
  /** Why this is recommended — 1-2 sentences, ≤ 240 chars. */
  rationale: string;
  /** What kind of action the UI should offer. */
  actionKind:
    | 'send_email'
    | 'create_task'
    | 'reassign_owner'
    | 'update_stage'
    | 'add_note';
  /** Optional suggested action payload (e.g. email subject, task title). */
  suggestion?: {
    text?: string;
    dueInDays?: number;
  };
  confidence: number;
  /** Learned-pattern provenance — populated by recommendation runner V2. */
  patternSource?: Array<{
    patternType: string;
    confidence: number;
    sampleSize: number;
    headline: string;
    detail?: string;
  }>;
};

/**
 * Output of the daily executive summary. The model writes 3-6 bullet
 * points; we render them as a list. Each bullet is short — one signal,
 * one number, one qualifier — never a paragraph.
 */
export type DailyExecSummary = {
  /** One-line topline (e.g. "Pipeline grew 14% this week"). */
  headline: string;
  /** 3-6 bullet observations. */
  bullets: string[];
  /** Top callout requiring attention; optional. */
  callout?: {
    title: string;
    detail: string;
    severity: RiskSeverity;
  };
};

/**
 * Pipeline intelligence summary. Distinct from forecast/velocity reports
 * — this is the narrative layer that wraps them.
 */
export type PipelineSummary = {
  headline: string;
  bullets: string[];
  /** Stages flagged as bottlenecks, sorted by severity. */
  bottlenecks: { stage: string; reason: string }[];
};

/**
 * Per-deal AI summary. Mirrors the brief: timeline / risks / next steps
 * stay separate so the UI can highlight each independently.
 */
export type DealAiSummary = {
  /** 2-3 sentence narrative. */
  narrative: string;
  /** Up to 3 risks. Empty array when none detected. */
  risks: string[];
  /** Up to 3 suggested next actions. */
  nextActions: string[];
  /** Model's self-reported confidence 0-1. */
  confidence: number;
};
