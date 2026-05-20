'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useRealtimeEvents } from './use-realtime-events';

/**
 * Two-way typing-indicator hook for a single thread.
 *
 * Outbound: call `notifyTyping()` whenever the user types. It debounces
 * to one publish per 3s and emits `typing.stopped` after 4s of silence.
 *
 * Inbound: the hook returns a map of remote users currently typing in
 * the same thread. Entries auto-expire 6s after their last seen
 * `typing.started`, covering missed `typing.stopped` events.
 */
export type TypingPeer = {
  userId: string;
  displayName: string | null;
  lastSeen: number;
};

const PUBLISH_DEBOUNCE_MS = 3_000;
const STOP_IDLE_MS = 4_000;
const PEER_TTL_MS = 6_000;

export function useTypingIndicators(args: {
  tenantId: string;
  currentUserId: string;
  thread: {
    type: 'comment' | 'note' | 'email';
    entityType: string;
    entityId: string;
  };
}): {
  peers: TypingPeer[];
  notifyTyping: () => void;
} {
  const [peers, setPeers] = useState<TypingPeer[]>([]);
  const lastPublishRef = useRef<number>(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadKey = `${args.thread.type}:${args.thread.entityType}:${args.thread.entityId}`;

  const publish = useCallback(
    async (kind: 'typing.started' | 'typing.stopped') => {
      try {
        await fetch('/api/realtime/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, thread: args.thread }),
        });
      } catch {
        /* best-effort */
      }
    },
    [args.thread],
  );

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastPublishRef.current > PUBLISH_DEBOUNCE_MS) {
      lastPublishRef.current = now;
      void publish('typing.started');
    }
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = setTimeout(() => {
      lastPublishRef.current = 0;
      void publish('typing.stopped');
    }, STOP_IDLE_MS);
  }, [publish]);

  // TTL pruning so peers fade out if their `typing.stopped` is lost.
  useEffect(() => {
    const id = setInterval(() => {
      setPeers((prev) => {
        const now = Date.now();
        const filtered = prev.filter((p) => now - p.lastSeen < PEER_TTL_MS);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 1500);
    return () => {
      clearInterval(id);
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    };
  }, []);

  useRealtimeEvents(args.tenantId, (event) => {
    if (event.type === 'typing.started') {
      if (event.userId === args.currentUserId) return;
      const k = `${event.thread.type}:${event.thread.entityType}:${event.thread.entityId}`;
      if (k !== threadKey) return;
      setPeers((prev) => {
        const now = Date.now();
        const existing = prev.findIndex((p) => p.userId === event.userId);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = { ...next[existing]!, lastSeen: now };
          return next;
        }
        return [
          ...prev,
          {
            userId: event.userId,
            displayName: event.displayName,
            lastSeen: now,
          },
        ];
      });
    } else if (event.type === 'typing.stopped') {
      if (event.userId === args.currentUserId) return;
      const k = `${event.thread.type}:${event.thread.entityType}:${event.thread.entityId}`;
      if (k !== threadKey) return;
      setPeers((prev) => prev.filter((p) => p.userId !== event.userId));
    }
  });

  return { peers, notifyTyping };
}
