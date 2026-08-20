'use client';

import { useEffect, useState } from 'react';

import { useRealtimeEvents } from './use-realtime-events';

/**
 * Track who else is currently viewing the same entity. The local user
 * publishes `viewing.started` on mount and `viewing.stopped` on unmount,
 * plus a heartbeat every 25s to refresh other clients' liveness windows.
 *
 * Each remote viewer is stored with a `lastSeen` timestamp; entries
 * older than 30s are pruned. This means a hung tab fades out within
 * one heartbeat cycle without us writing to the DB.
 *
 * Returns the deduplicated viewer list (excluding the current user).
 */
export type EntityViewer = {
  userId: string;
  displayName: string | null;
  imageUrl: string | null;
  lastSeen: number;
};

/**
 * Liveness window for a remote viewer, and how often we refresh our own.
 *
 * Every heartbeat is a POST to /api/realtime/publish — a serverless
 * invocation that verifies the session, reads the `users` row for display
 * info, and issues a pg_notify. At the previous 22s cadence a single deal
 * page left open cost ~160 invocations an hour, per viewer, forever.
 *
 * A clean unmount still publishes `viewing.stopped` immediately, so the TTL
 * only governs how long a *crashed* tab lingers in the list. Trading a
 * slower fade-out for a third of the request volume is the right side of
 * that deal. TTL stays above 2x the heartbeat so a single dropped beat
 * never makes a live viewer flicker out.
 */
const VIEWER_TTL_MS = 140_000;
const HEARTBEAT_MS = 55_000;

export function useEntityViewers(args: {
  tenantId: string;
  currentUserId: string;
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
}): EntityViewer[] {
  const [viewers, setViewers] = useState<EntityViewer[]>([]);

  // Publish own presence + heartbeat for the lifetime of this component.
  useEffect(() => {
    const payload = {
      kind: 'viewing.started',
      entity: { type: args.entityType, id: args.entityId },
    };
    const publish = async (kind: 'viewing.started' | 'viewing.stopped') => {
      try {
        await fetch('/api/realtime/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, kind }),
        });
      } catch {
        // Best-effort — silent on failure.
      }
    };
    void publish('viewing.started');
    const beat = setInterval(() => {
      void publish('viewing.started');
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(beat);
      void publish('viewing.stopped');
    };
  }, [args.entityType, args.entityId]);

  // Stale pruning ticker.
  useEffect(() => {
    const id = setInterval(() => {
      setViewers((prev) => {
        const now = Date.now();
        const filtered = prev.filter((v) => now - v.lastSeen < VIEWER_TTL_MS);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 5000);
    return () => clearInterval(id);
  }, []);

  useRealtimeEvents(args.tenantId, (event) => {
    if (event.type === 'viewing.started') {
      if (event.entity.type !== args.entityType) return;
      if (event.entity.id !== args.entityId) return;
      if (event.userId === args.currentUserId) return;
      setViewers((prev) => {
        const now = Date.now();
        const existing = prev.findIndex((v) => v.userId === event.userId);
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
            imageUrl: event.imageUrl,
            lastSeen: now,
          },
        ];
      });
    } else if (event.type === 'viewing.stopped') {
      if (event.entity.type !== args.entityType) return;
      if (event.entity.id !== args.entityId) return;
      setViewers((prev) =>
        prev.filter((v) => v.userId !== event.userId),
      );
    }
  });

  return viewers;
}
