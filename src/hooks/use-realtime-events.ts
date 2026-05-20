'use client';

import { useEffect, useRef } from 'react';

import type { RealtimeEnvelope, RealtimeEvent } from '@/lib/realtime/events';

const SEEN_CAP = 1000;
const SEEN_DRAIN = 500;
/** Pause the EventSource after this many ms of tab-hidden. */
const HIDDEN_PAUSE_MS = 5 * 60 * 1000;

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
 * - Visibility: if the tab is hidden for > 5 minutes we close the
 *   connection so an idle tab doesn't hold a server LISTEN forever.
 *   When the tab becomes visible again the connection is reopened and
 *   the server replays missed events via Last-Event-ID.
 *
 * The handler ref pattern (`onEventRef`) lets callers pass a fresh closure
 * every render without re-establishing the EventSource — the connection is
 * keyed only by `tenantId`.
 */
export function useRealtimeEvents(
  tenantId: string,
  onEvent: (event: RealtimeEvent) => void,
): void {
  // Intentional: this ref pattern keeps the handler closure fresh without
  // forcing a new EventSource on every render. The connection is keyed
  // only by tenantId.
  const onEventRef = useRef(onEvent);
  // eslint-disable-next-line react-hooks/refs
  onEventRef.current = onEvent;

  useEffect(() => {
    const seen = new Set<string>();
    let source: EventSource | null = null;
    let hiddenSince: number | null = null;
    let pauseTimer: ReturnType<typeof setTimeout> | null = null;

    function open() {
      if (source) return;
      source = new EventSource('/api/realtime/events');

      source.onmessage = (e) => {
        try {
          const envelope = JSON.parse(e.data) as RealtimeEnvelope;

          if (envelope.event.tenantId !== tenantId) return;
          if (seen.has(envelope.id)) return;
          seen.add(envelope.id);

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
          console.warn('[realtime] failed to parse event:', err);
        }
      };

      source.onerror = () => {
        if (source && source.readyState === EventSource.CLOSED) {
          console.warn('[realtime] connection closed');
        }
      };
    }

    function close() {
      if (pauseTimer) {
        clearTimeout(pauseTimer);
        pauseTimer = null;
      }
      if (source) {
        source.close();
        source = null;
      }
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        hiddenSince = Date.now();
        // Defer disconnect — a brief alt-tab shouldn't drop the stream.
        // After HIDDEN_PAUSE_MS we close; visibilitychange back to
        // 'visible' reopens immediately and the server replays via
        // Last-Event-ID.
        pauseTimer = setTimeout(() => {
          close();
        }, HIDDEN_PAUSE_MS);
      } else {
        hiddenSince = null;
        if (pauseTimer) {
          clearTimeout(pauseTimer);
          pauseTimer = null;
        }
        if (!source) open();
      }
    }

    open();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
      // Reference hiddenSince so it doesn't get unused-var-stripped — also
      // documents that the timestamp is captured for future diagnostics.
      void hiddenSince;
    };
  }, [tenantId]);
}

/**
 * Selector hook: subscribe to realtime events of a single discriminated
 * variant. Thin wrapper around `useRealtimeEvents` that runs the handler
 * only when `event.type === type`. Reduces boilerplate in feature
 * components that care about one event class.
 */
export function useRealtimeEventOfType<K extends RealtimeEvent['type']>(
  tenantId: string,
  type: K,
  onEvent: (event: Extract<RealtimeEvent, { type: K }>) => void,
): void {
  const onEventRef = useRef(onEvent);
  // eslint-disable-next-line react-hooks/refs -- same pattern as the base hook.
  onEventRef.current = onEvent;
  useRealtimeEvents(tenantId, (e) => {
    if (e.type === type) {
      onEventRef.current(e as Extract<RealtimeEvent, { type: K }>);
    }
  });
}
