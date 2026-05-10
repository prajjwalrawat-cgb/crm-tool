'use client';

import { useEffect, useRef } from 'react';

import type { RealtimeEnvelope, RealtimeEvent } from '@/lib/realtime/events';

const SEEN_CAP = 1000;
const SEEN_DRAIN = 500;

/**
 * Subscribe to the per-tenant SSE realtime stream.
 *
 * - Native EventSource handles reconnect with exponential backoff out of
 *   the box; we just feed it our endpoint URL.
 * - Tenant defense: we receive the active user's tenant channel server-
 *   side, but as belt-and-suspenders the client still drops events whose
 *   `tenantId` doesn't match the expected one.
 * - Dedup: events carry a uuid `id`. We keep a bounded LRU-ish set so a
 *   reconnect that replays recent events doesn't trigger duplicate UI
 *   updates.
 *
 * The handler ref pattern (`onEventRef`) lets callers pass a fresh closure
 * every render without re-establishing the EventSource — the connection is
 * keyed only by `tenantId`.
 */
export function useRealtimeEvents(
  tenantId: string,
  onEvent: (event: RealtimeEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const seen = new Set<string>();
    const source = new EventSource('/api/realtime/events');

    source.onmessage = (e) => {
      try {
        const envelope = JSON.parse(e.data) as RealtimeEnvelope;

        // Tenant guard: events we shouldn't see are silently dropped.
        if (envelope.event.tenantId !== tenantId) return;

        // Dedup by envelope id.
        if (seen.has(envelope.id)) return;
        seen.add(envelope.id);

        // Bound the dedup set so it doesn't grow forever on a long-lived
        // session. Drop the oldest half when we hit the cap.
        if (seen.size > SEEN_CAP) {
          const drainCount = seen.size - SEEN_DRAIN;
          let i = 0;
          for (const id of seen) {
            if (i++ >= drainCount) break;
            seen.delete(id);
          }
        }

        onEventRef.current(envelope.event);
      } catch (err) {
        // Malformed payload — log once, keep the stream open.
        console.warn('[realtime] failed to parse event:', err);
      }
    };

    source.onerror = () => {
      // EventSource auto-reconnects on its own retry interval. We log so
      // intermittent network issues are visible during dev.
      if (source.readyState === EventSource.CLOSED) {
        console.warn('[realtime] connection closed');
      }
    };

    return () => {
      source.close();
    };
  }, [tenantId]);
}
