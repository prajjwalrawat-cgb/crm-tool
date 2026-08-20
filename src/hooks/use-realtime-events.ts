'use client';

import { useEffect, useRef } from 'react';

import type { RealtimeEnvelope, RealtimeEvent } from '@/lib/realtime/events';

const SEEN_CAP = 1000;
const SEEN_DRAIN = 500;
/** Pause the EventSource after this many ms of tab-hidden. */
const HIDDEN_PAUSE_MS = 5 * 60 * 1000;
/**
 * Grace period before tearing down a channel that has lost its last
 * subscriber. Client-side navigation unmounts the old page's components
 * before mounting the new page's, and React StrictMode double-invokes
 * effects in dev — without a linger, both would drop the connection and
 * immediately reopen it, paying a full reconnect (auth + LISTEN + presence
 * broadcast) for nothing.
 */
const LINGER_MS = 3_000;

/* ------------------------------------------------------------------ *
 * Shared connection registry
 *
 * ONE EventSource per tenant per tab, not one per hook call.
 *
 * Every `useRealtimeEvents` / `useRealtimeEventOfType` call used to open
 * its own EventSource. The dashboard header alone mounts two of them
 * (notification bell + presence indicator) on every page, and a deal
 * detail page adds the inline header, entity viewers, the comments thread
 * and its typing indicator — six or more concurrent streams per tab.
 *
 * Each stream is a *long-lived server invocation*: on Vercel's Fluid
 * compute the function instance stays provisioned for the whole life of
 * the response, so N streams meant N times the GB-hours, N Postgres
 * LISTEN registrations, N presence entries for the same user, and a
 * presence broadcast storm on every page navigation. Multiplexing them
 * onto one connection cuts all of that by the same factor.
 *
 * The registry is module-level (per tab). Handlers are stored in a Set and
 * invoked in insertion order for each envelope; dedup and the tenant guard
 * run once, centrally, instead of once per subscriber.
 * ------------------------------------------------------------------ */

type Handler = (event: RealtimeEvent) => void;

type Channel = {
  source: EventSource | null;
  handlers: Set<Handler>;
  /** Envelope ids already dispatched, so a reconnect replay is idempotent. */
  seen: Set<string>;
  /** Pending teardown after the last unsubscribe (see LINGER_MS). */
  lingerTimer: ReturnType<typeof setTimeout> | null;
  /** Pending disconnect after the tab has been hidden (see HIDDEN_PAUSE_MS). */
  pauseTimer: ReturnType<typeof setTimeout> | null;
  onVisibility: (() => void) | null;
};

const channels = new Map<string, Channel>();

function dispatch(channel: Channel, tenantId: string, raw: string): void {
  let envelope: RealtimeEnvelope;
  try {
    envelope = JSON.parse(raw) as RealtimeEnvelope;
  } catch (err) {
    console.warn('[realtime] failed to parse event:', err);
    return;
  }

  // Tenant defense: the server only ever writes the active tenant's
  // channel, but drop anything mismatched as belt-and-suspenders.
  if (envelope.event.tenantId !== tenantId) return;
  if (channel.seen.has(envelope.id)) return;
  channel.seen.add(envelope.id);

  if (channel.seen.size > SEEN_CAP) {
    const drainCount = channel.seen.size - SEEN_DRAIN;
    let i = 0;
    for (const id of channel.seen) {
      if (i++ >= drainCount) break;
      channel.seen.delete(id);
    }
  }

  // Snapshot before iterating: a handler may unsubscribe (or mount a
  // component that subscribes) while we're dispatching.
  for (const handler of Array.from(channel.handlers)) {
    try {
      handler(envelope.event);
    } catch (err) {
      // One bad subscriber must not starve the rest of the page.
      console.error('[realtime] subscriber threw:', err);
    }
  }
}

function openSource(channel: Channel, tenantId: string): void {
  if (channel.source) return;
  const source = new EventSource('/api/realtime/events');
  channel.source = source;
  source.onmessage = (e) => dispatch(channel, tenantId, e.data);
  source.onerror = () => {
    // EventSource reconnects on its own with backoff; CLOSED means it gave
    // up (usually a 401/403), which is worth surfacing.
    if (source.readyState === EventSource.CLOSED) {
      console.warn('[realtime] connection closed');
    }
  };
}

function closeSource(channel: Channel): void {
  if (channel.pauseTimer) {
    clearTimeout(channel.pauseTimer);
    channel.pauseTimer = null;
  }
  if (channel.source) {
    channel.source.close();
    channel.source = null;
  }
}

/**
 * Attach a handler to the tenant's shared stream, opening it if this is the
 * first subscriber. Returns an unsubscribe function.
 *
 * Exported for `scripts/selftest-realtime-sharing.ts`, which drives it with
 * stubbed `EventSource`/`document` globals to assert the one-connection
 * invariant. React callers should use `useRealtimeEvents` instead.
 */
export function subscribeToRealtimeChannel(
  tenantId: string,
  handler: Handler,
): () => void {
  return subscribe(tenantId, handler);
}

function subscribe(tenantId: string, handler: Handler): () => void {
  let channel = channels.get(tenantId);

  if (!channel) {
    channel = {
      source: null,
      handlers: new Set(),
      seen: new Set(),
      lingerTimer: null,
      pauseTimer: null,
      onVisibility: null,
    };
    channels.set(tenantId, channel);

    const ch = channel;
    ch.onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // Defer disconnect — a brief alt-tab shouldn't drop the stream.
        if (ch.pauseTimer) clearTimeout(ch.pauseTimer);
        ch.pauseTimer = setTimeout(() => closeSource(ch), HIDDEN_PAUSE_MS);
      } else {
        if (ch.pauseTimer) {
          clearTimeout(ch.pauseTimer);
          ch.pauseTimer = null;
        }
        // Reopen; the server replays what we missed via Last-Event-ID.
        if (ch.handlers.size > 0) openSource(ch, tenantId);
      }
    };
    document.addEventListener('visibilitychange', ch.onVisibility);
  }

  // A new subscriber cancels a pending teardown — this is the navigation
  // case, where the connection is reused instead of cycled.
  if (channel.lingerTimer) {
    clearTimeout(channel.lingerTimer);
    channel.lingerTimer = null;
  }

  channel.handlers.add(handler);
  openSource(channel, tenantId);

  return () => {
    const ch = channels.get(tenantId);
    if (!ch) return;
    ch.handlers.delete(handler);
    if (ch.handlers.size > 0) return;

    // Last subscriber left. Linger briefly in case this is a navigation
    // rather than a genuine teardown.
    if (ch.lingerTimer) clearTimeout(ch.lingerTimer);
    ch.lingerTimer = setTimeout(() => {
      const current = channels.get(tenantId);
      if (!current || current.handlers.size > 0) return;
      closeSource(current);
      if (current.onVisibility) {
        document.removeEventListener('visibilitychange', current.onVisibility);
      }
      channels.delete(tenantId);
    }, LINGER_MS);
  };
}

/**
 * Subscribe to the per-tenant SSE realtime stream.
 *
 * - All callers in a tab share ONE EventSource per tenant (see the
 *   registry above). Mounting more realtime-aware components costs
 *   nothing on the server.
 * - Native EventSource handles reconnect with exponential backoff; the
 *   server replays missed envelopes via `Last-Event-ID`.
 * - Dedup: events carry a uuid `id`, tracked in a bounded set on the
 *   shared channel so a replay doesn't re-fire handlers.
 * - Visibility: after 5 minutes hidden the connection closes so an idle
 *   tab doesn't hold a server LISTEN open; it reopens on focus.
 *
 * The handler ref pattern lets callers pass a fresh closure every render
 * without re-establishing the subscription.
 */
export function useRealtimeEvents(
  tenantId: string,
  onEvent: (event: RealtimeEvent) => void,
): void {
  // Intentional: this ref pattern keeps the handler closure fresh without
  // resubscribing on every render. The subscription is keyed only by
  // tenantId.
  const onEventRef = useRef(onEvent);
  // eslint-disable-next-line react-hooks/refs
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!tenantId) return;
    // Stable indirection so the Set entry never changes identity across
    // renders — the registry keys unsubscribe off this exact reference.
    const handler: Handler = (event) => onEventRef.current(event);
    return subscribe(tenantId, handler);
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
