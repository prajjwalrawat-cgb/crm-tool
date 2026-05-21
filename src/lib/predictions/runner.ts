import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';
import { UUID_REGEX_LITERAL } from '@/lib/db-sql/safe-uuid';

import {
  PREDICTION_NOISE_FLOOR,
  type Prediction,
  type PredictionSignal,
} from './types';

/**
 * Predictive intelligence runner. Pure SQL aggregates + deterministic
 * scoring formulas — no ML, no LLM calls. Outputs are stable: same
 * input data always produces the same Prediction.
 *
 * Composition: every prediction is scored from independent signal
 * contributions then clamped to [0, 1]. The signal codes that fired
 * are surfaced on the Prediction so the UI can render the breakdown
 * without re-deriving it.
 *
 * v1 ships THREE predictions per active deal:
 *   - deal_momentum  → did the deal advance lately + how much activity
 *   - stale_risk     → projected stalling probability
 *   - close_probability → blended of deal.probability + momentum
 *
 * Each prediction is tenant-scoped; we never aggregate across tenants.
 */

/**
 * Top-N predictions per tenant, sorted by severity (highest concern
 * first). The Command Center reads this directly.
 */
export async function getTopPredictionsForTenant(
  tenantId: string,
  options: { limit?: number } = {},
): Promise<Prediction[]> {
  const limit = options.limit ?? 12;

  // Raw signal frame: per active deal, pull the inputs we need to
  // compute every prediction in one pass. Restricting to active stages
  // — won/lost deals don't need momentum / stale-risk scoring.
  type Row = {
    deal_id: string;
    name: string;
    stage: string;
    amount_minor: number;
    probability: number | null;
    expected_close_date: string | null;
    days_since_created: number;
    days_since_last_activity: number | null;
    days_since_last_email: number | null;
    days_since_last_stage_change: number | null;
    activity_count_14d: number;
    email_failed_30d: number;
    overdue_tasks: number;
    last_stage_action: string | null;
  };
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH last_act AS (
        SELECT entity_id::uuid AS deal_id, max(created_at) AS at
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
        GROUP BY entity_id
      ),
      last_stage AS (
        SELECT
          entity_id::uuid AS deal_id,
          max(created_at) AS at,
          (array_agg(metadata->>'to' ORDER BY created_at DESC))[1] AS last_to
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND action = 'stage_changed'
          AND entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
        GROUP BY entity_id
      ),
      last_email AS (
        SELECT entity_id AS deal_id, max(created_at) AS at
        FROM email_messages
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id IS NOT NULL
        GROUP BY entity_id
      ),
      activity_14d AS (
        SELECT entity_id::uuid AS deal_id, count(*)::int AS n
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
          AND created_at >= now() - INTERVAL '14 days'
        GROUP BY entity_id
      ),
      email_failed_30d AS (
        SELECT entity_id AS deal_id, count(*)::int AS n
        FROM email_messages
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id IS NOT NULL
          AND status = 'failed'
          AND created_at >= now() - INTERVAL '30 days'
        GROUP BY entity_id
      ),
      overdue AS (
        SELECT entity_id AS deal_id, count(*)::int AS n
        FROM tasks
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id IS NOT NULL
          AND status IN ('todo','in_progress')
          AND due_date IS NOT NULL
          AND due_date < current_date
        GROUP BY entity_id
      )
      SELECT
        d.id                                                              AS deal_id,
        d.name                                                            AS name,
        d.stage::text                                                     AS stage,
        d.amount_minor                                                    AS amount_minor,
        d.probability                                                     AS probability,
        d.expected_close_date                                             AS expected_close_date,
        floor(extract(epoch FROM (now() - d.created_at)) / 86400.0)::int AS days_since_created,
        floor(extract(epoch FROM (now() - la.at)) / 86400.0)::int        AS days_since_last_activity,
        floor(extract(epoch FROM (now() - le.at)) / 86400.0)::int        AS days_since_last_email,
        floor(extract(epoch FROM (now() - ls.at)) / 86400.0)::int        AS days_since_last_stage_change,
        coalesce(a14.n, 0)                                                AS activity_count_14d,
        coalesce(ef.n, 0)                                                 AS email_failed_30d,
        coalesce(o.n, 0)                                                  AS overdue_tasks,
        ls.last_to                                                        AS last_stage_action
      FROM deals d
      LEFT JOIN last_act    la ON la.deal_id = d.id
      LEFT JOIN last_stage  ls ON ls.deal_id = d.id
      LEFT JOIN last_email  le ON le.deal_id = d.id
      LEFT JOIN activity_14d a14 ON a14.deal_id = d.id
      LEFT JOIN email_failed_30d ef ON ef.deal_id = d.id
      LEFT JOIN overdue     o  ON o.deal_id  = d.id
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.deleted_at IS NULL
        AND d.stage IN ('lead','qualified','proposal','negotiation')
    `),
  )) as unknown as Row[];

  const out: Prediction[] = [];

  for (const r of rows) {
    out.push(...computeForDeal(r));
  }

  // Filter noise and sort by severity. For stale_risk and comm_risk
  // we want HIGH values first (riskier deals); for close_probability
  // we want LOW values first (deals at risk of NOT closing) — but
  // since the Command Center uses these for triage, we rank by
  // `urgency = (1 - confidence_adjusted_value) + signal_count_weight`.
  const filtered = out.filter((p) => p.confidence >= PREDICTION_NOISE_FLOOR);
  filtered.sort((a, b) => severityRank(b) - severityRank(a));
  return filtered.slice(0, limit);
}

function severityRank(p: Prediction): number {
  // Stale/comm risks rank by raw value (higher = worse).
  if (p.kind === 'stale_risk' || p.kind === 'comm_risk') {
    return p.value * 100 + p.signals.length;
  }
  // Momentum: low + downward = concerning.
  if (p.kind === 'deal_momentum') {
    return (1 - p.value) * 80 + (p.trend === 'down' ? 10 : 0);
  }
  // Close probability: very low value = concern (deal won't close).
  return (1 - p.value) * 90;
}

/** Per-deal computation. Returns up to 3 Prediction rows. */
function computeForDeal(
  r: {
    deal_id: string;
    name: string;
    stage: string;
    amount_minor: number;
    probability: number | null;
    expected_close_date: string | null;
    days_since_created: number;
    days_since_last_activity: number | null;
    days_since_last_email: number | null;
    days_since_last_stage_change: number | null;
    activity_count_14d: number;
    email_failed_30d: number;
    overdue_tasks: number;
    last_stage_action: string | null;
  },
): Prediction[] {
  const predictions: Prediction[] = [];

  // ----- deal_momentum -----
  // Positive contributions: recent activity, recent stage advance.
  // Negative: long silence, regression, overdue tasks.
  const momentumSignals: PredictionSignal[] = [];
  let momentum = 0.5;
  if (r.activity_count_14d >= 5) {
    momentum += 0.2;
    momentumSignals.push('frequent_activity');
  } else if (r.activity_count_14d <= 1) {
    momentum -= 0.15;
    momentumSignals.push('sparse_activity');
  }
  if (r.days_since_last_stage_change !== null && r.days_since_last_stage_change <= 7) {
    momentum += 0.15;
    momentumSignals.push('recent_stage_advance');
  }
  if (r.days_since_last_email !== null && r.days_since_last_email <= 5) {
    momentum += 0.1;
    momentumSignals.push('high_email_engagement');
  } else if (r.days_since_last_email !== null && r.days_since_last_email > 21) {
    momentum -= 0.1;
    momentumSignals.push('low_email_engagement');
  }
  if (r.overdue_tasks >= 2) {
    momentum -= 0.15;
    momentumSignals.push('overdue_tasks');
  }
  momentum = clamp01(momentum);
  const momentumConfidence = clamp01(
    0.3 + (r.activity_count_14d > 0 ? 0.25 : 0) + (r.days_since_last_email !== null ? 0.15 : 0),
  );
  predictions.push({
    kind: 'deal_momentum',
    entityType: 'deal',
    entityId: r.deal_id,
    entityName: r.name,
    value: momentum,
    trend: momentum > 0.6 ? 'up' : momentum < 0.4 ? 'down' : 'flat',
    confidence: momentumConfidence,
    signals: momentumSignals,
    explanation: explainMomentum(momentum, momentumSignals),
    supporting: [
      { label: 'Activity (14d)', value: String(r.activity_count_14d) },
      { label: 'Days since stage move', value: nullOrDays(r.days_since_last_stage_change) },
    ],
  });

  // ----- stale_risk -----
  // Higher value = MORE at risk. Threshold-driven from idle days.
  const staleSignals: PredictionSignal[] = [];
  let stale = 0;
  const idle = Math.max(
    r.days_since_last_activity ?? r.days_since_created,
    r.days_since_last_stage_change ?? r.days_since_created,
  );
  if (idle >= 30) {
    stale += 0.5;
    staleSignals.push('long_silence');
  } else if (idle >= 14) {
    stale += 0.3;
  }
  if ((r.days_since_last_stage_change ?? r.days_since_created) >= 21) {
    stale += 0.2;
    staleSignals.push('aging_open_deal');
  }
  if (r.email_failed_30d >= 1) {
    stale += 0.1;
    staleSignals.push('multiple_failed_sends');
  }
  stale = clamp01(stale);
  const staleConfidence = clamp01(
    0.4 + Math.min(0.3, r.days_since_created / 180),
  );
  predictions.push({
    kind: 'stale_risk',
    entityType: 'deal',
    entityId: r.deal_id,
    entityName: r.name,
    value: stale,
    trend: 'flat',
    confidence: staleConfidence,
    signals: staleSignals,
    explanation: explainStaleRisk(stale, idle),
    supporting: [
      { label: 'Idle days', value: String(idle) },
      { label: 'Failed sends (30d)', value: String(r.email_failed_30d) },
    ],
  });

  // ----- close_probability -----
  // Blend the explicit deals.probability with momentum + window.
  const baseProb = (r.probability ?? 0) / 100;
  const windowFactor = closeWindowFactor(r.expected_close_date);
  const closeSignals: PredictionSignal[] = [];
  if (windowFactor < 0.5) closeSignals.push('short_window_to_close');
  if (baseProb < 0.3 && r.amount_minor >= 5_000_000) {
    closeSignals.push('low_probability_high_value');
  }
  if (momentumSignals.includes('recent_stage_advance')) {
    closeSignals.push('recent_stage_advance');
  }
  const close = clamp01(0.6 * baseProb + 0.3 * momentum + 0.1 * windowFactor);
  const closeConfidence = clamp01(
    0.3 + (r.probability !== null ? 0.3 : 0) + (windowFactor > 0 ? 0.2 : 0),
  );
  predictions.push({
    kind: 'close_probability',
    entityType: 'deal',
    entityId: r.deal_id,
    entityName: r.name,
    value: close,
    trend: 'flat',
    confidence: closeConfidence,
    signals: closeSignals,
    explanation: explainCloseProbability(close),
    supporting: [
      {
        label: 'Stage probability',
        value: r.probability !== null ? `${r.probability}%` : '—',
      },
      {
        label: 'Window',
        value: r.expected_close_date ?? 'unset',
      },
    ],
  });

  return predictions;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function nullOrDays(d: number | null): string {
  return d === null ? '—' : `${d}d`;
}

function closeWindowFactor(expected: string | null): number {
  if (!expected) return 0.4;
  const expectedMs = Date.parse(`${expected}T00:00:00Z`);
  if (Number.isNaN(expectedMs)) return 0.4;
  const daysAway = (expectedMs - Date.now()) / (24 * 60 * 60 * 1000);
  if (daysAway < 0) return 0.2; // already past
  if (daysAway > 90) return 0.6;
  if (daysAway > 30) return 0.85;
  return 1; // within 30 days
}

function explainMomentum(value: number, signals: PredictionSignal[]): string {
  if (value > 0.65) {
    return signals.includes('frequent_activity')
      ? 'Strong recent activity and engagement — momentum is positive.'
      : 'Recent stage movement is pushing this deal forward.';
  }
  if (value < 0.4) {
    if (signals.includes('overdue_tasks')) {
      return 'Open tasks are slipping and engagement is dropping.';
    }
    return 'Activity has slowed; nudge with a follow-up to restart momentum.';
  }
  return 'Steady — no recent acceleration or deceleration.';
}

function explainStaleRisk(value: number, idle: number): string {
  if (value > 0.6) {
    return `${idle} days without movement — high risk of stalling.`;
  }
  if (value > 0.4) {
    return `${idle} days idle; consider re-engaging in the next week.`;
  }
  return 'Activity within healthy bounds.';
}

function explainCloseProbability(value: number): string {
  if (value > 0.7) return 'On track to close within the expected window.';
  if (value < 0.3) return 'Likely to slip — probability or momentum is low.';
  return 'Tracking near the model baseline.';
}
