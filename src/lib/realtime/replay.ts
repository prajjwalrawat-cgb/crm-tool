import 'server-only';

import type { RealtimeEnvelope } from './events';

/**
 * Per-tenant ring buffer of recently-broadcast realtime envelopes. The
 * SSE LISTEN handler appends each incoming envelope here so reconnecting
 * clients can replay events they missed while their EventSource was in
 * its retry interval.
 *
 * Design:
 *   - Bounded capacity (200 envelopes per tenant) to keep memory finite.
 *     At ~1KB/envelope that's ~200KB per active tenant — fine.
 *   - In-memory only. Each Node process keeps its own ring. A client
 *     that reconnects to a *different* process (multi-instance deploy
 *     without session affinity) loses replay. Documented limit; the
 *     dedup-by-id on the client guarantees correctness either way.
 *   - LRU drop: when a new envelope pushes the count past the cap, the
 *     oldest envelope is evicted. Reads always return newest-first.
 *
 * The publish path stays untouched — `pg_notify` is still the canonical
 * fan-out. Replay is purely a reconnect convenience.
 */

const CAPACITY_PER_TENANT = 200;

const buffers = new Map<string, RealtimeEnvelope[]>();

/** Append an envelope to its tenant's ring. */
export function recordEnvelope(envelope: RealtimeEnvelope): void {
  const tenantId = envelope.event.tenantId;
  let ring = buffers.get(tenantId);
  if (!ring) {
    ring = [];
    buffers.set(tenantId, ring);
  }
  ring.push(envelope);
  if (ring.length > CAPACITY_PER_TENANT) {
    ring.splice(0, ring.length - CAPACITY_PER_TENANT);
  }
}

/**
 * Return all envelopes for `tenantId` strictly newer than `afterId`.
 * If `afterId` is unknown to the buffer (rotated out or different
 * process), return an empty array — the client already has its dedup
 * set, so a missed window is harmless.
 *
 * Ordered oldest-first so the SSE replay writes them in the same order
 * they originally fired.
 */
export function envelopesSince(
  tenantId: string,
  afterId: string | null,
): RealtimeEnvelope[] {
  const ring = buffers.get(tenantId);
  if (!ring || ring.length === 0) return [];
  if (!afterId) return [];
  const idx = ring.findIndex((e) => e.id === afterId);
  if (idx < 0) return [];
  return ring.slice(idx + 1);
}

/** Number of envelopes currently buffered for a tenant — exposed for ops. */
export function bufferDepth(tenantId: string): number {
  return buffers.get(tenantId)?.length ?? 0;
}
