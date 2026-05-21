import 'server-only';

import { and, eq } from 'drizzle-orm';

import {
  relationshipSignals,
  type RelationshipSignal,
  type RelationshipStatus,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Relationship-health scoring. Statistical, no ML — the formula is
 * explicit so the UI can render a per-signal breakdown alongside the
 * top-line score.
 *
 *   score = 0.4 × inbound_density(window=30d)
 *         + 0.3 × response_consistency
 *         + 0.3 × recency_decay(silent_days)
 *
 * The Inngest job that maintains the rolling-window inputs lands in
 * CP#16C-E. For v1 we expose an on-demand `computeRelationshipScore`
 * helper the UI uses when no cached score is present.
 *
 * Status buckets:
 *   ≥ 0.7  healthy
 *   ≥ 0.5  warming
 *   ≥ 0.3  stale
 *   < 0.3  at_risk
 */
export type SignalBreakdown = {
  inboundDensity: number;
  responseConsistency: number;
  recencyDecay: number;
  /** Combined 0..1 score. */
  score: number;
  status: RelationshipStatus;
  sampleSize: number;
};

export type RelationshipView = {
  signal: RelationshipSignal | null;
  breakdown: SignalBreakdown | null;
  /** Human-readable bullets the UI can render under "Why this score?" */
  explanations: string[];
};

const WINDOW_DAYS = 30;

/**
 * Read the cached signal row (UPSERTed by the send pipeline + future
 * inbound webhook handlers) and compute the score from it. Returns
 * `signal: null` when no row exists yet — the UI renders a "no data"
 * placeholder.
 */
export async function getRelationshipView(
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<RelationshipView> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(relationshipSignals)
      .where(
        and(
          eq(relationshipSignals.tenantId, tenantId),
          eq(relationshipSignals.entityType, entityType),
          eq(relationshipSignals.entityId, entityId),
        ),
      )
      .limit(1),
  );

  const signal = rows[0] ?? null;
  if (!signal) {
    return { signal: null, breakdown: null, explanations: [] };
  }

  const breakdown = computeBreakdownFromSignal(signal);
  const explanations = explain(signal, breakdown);
  return { signal, breakdown, explanations };
}

/**
 * Pure scoring function — same inputs always produce the same output.
 * Exposed for unit testing + future ad-hoc recomputes.
 */
export function computeBreakdownFromSignal(
  s: RelationshipSignal,
): SignalBreakdown {
  const sampleSize = s.totalInbound + s.totalOutbound;

  // 1. Inbound density: count of inbound in the 30d window, capped.
  //    We don't yet have a windowed counter — use totalInbound as a
  //    proxy. The Inngest job will swap this for a proper window.
  const inboundDensity = Math.min(1, s.totalInbound / 10);

  // 2. Response consistency: replies / outbound. Unanswered count
  //    inflates the denominator.
  const consistencyDen = s.totalOutbound + Math.max(0, s.unansweredCount);
  const responseConsistency =
    consistencyDen === 0 ? 0 : Math.min(1, s.totalInbound / consistencyDen);

  // 3. Recency decay: 1 when silent_days == 0; linear drop to 0 at 30d.
  const recencyDecay = Math.max(0, 1 - s.silentDays / WINDOW_DAYS);

  const score =
    0.4 * inboundDensity + 0.3 * responseConsistency + 0.3 * recencyDecay;

  const status: RelationshipStatus =
    score >= 0.7
      ? 'healthy'
      : score >= 0.5
        ? 'warming'
        : score >= 0.3
          ? 'stale'
          : 'at_risk';

  return {
    inboundDensity,
    responseConsistency,
    recencyDecay,
    score,
    status,
    sampleSize,
  };
}

/**
 * Human-readable "Why am I seeing this status?" bullets. The UI
 * renders them in the disclosure panel under the score chip.
 */
function explain(
  s: RelationshipSignal,
  b: SignalBreakdown,
): string[] {
  const out: string[] = [];

  if (b.sampleSize < 3) {
    out.push(
      `Only ${b.sampleSize} message(s) in the window — score will firm up with more activity.`,
    );
  }

  if (s.totalOutbound > 0) {
    const replyRate = Math.round(b.responseConsistency * 100);
    out.push(
      `${s.totalInbound} replies to ${s.totalOutbound} outbound sends (${replyRate}% consistency).`,
    );
  } else {
    out.push('No outbound sends recorded yet.');
  }

  if (s.unansweredCount > 0) {
    out.push(`${s.unansweredCount} outbound message(s) still awaiting a reply.`);
  }

  if (s.silentDays > 0) {
    out.push(
      `${s.silentDays} day(s) since the last bi-directional contact.`,
    );
  } else if (s.lastInboundAt || s.lastOutboundAt) {
    out.push('Active conversation in the last 24 hours.');
  }

  if (s.avgResponseHours != null) {
    out.push(`Average reply latency: ${s.avgResponseHours.toFixed(1)}h.`);
  }

  return out;
}
