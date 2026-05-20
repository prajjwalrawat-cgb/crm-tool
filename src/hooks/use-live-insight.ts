'use client';

import { useCallback, useState } from 'react';

import type { InsightState } from '@/lib/intelligence/types';

import { useRealtimeEventOfType } from './use-realtime-events';

/**
 * Keep a single AI insight live. Initial state is whatever the server
 * passed during SSR; the hook re-fetches from `/api/intelligence/insight`
 * when an `ai.summary.updated` event arrives for THIS (type, id).
 *
 * Used by every AiInsightCard on every page — one hook per card. The
 * underlying SSE connection is shared (the dashboard shell owns one
 * EventSource); we just attach selector handlers.
 *
 * The hook never blocks SSR. On the server it returns the initial
 * payload as-is; on the client it begins listening after mount.
 */
export type LiveInsightState<T> = {
  state: InsightState;
  content: T | null;
  generatedAt: string | null;
  /** True while the re-fetch is in flight. */
  refreshing: boolean;
};

export function useLiveInsight<T>(args: {
  tenantId: string;
  type: string;
  /** Entity id — `"global"` for tenant-wide insights. */
  id: string;
  initial: {
    state: InsightState;
    content: T | null;
    generatedAt: string | null;
  };
}): LiveInsightState<T> {
  const [view, setView] = useState<LiveInsightState<T>>({
    ...args.initial,
    refreshing: false,
  });

  const refresh = useCallback(async () => {
    setView((prev) => ({ ...prev, refreshing: true }));
    try {
      const res = await fetch(
        `/api/intelligence/insight?type=${encodeURIComponent(args.type)}&id=${encodeURIComponent(args.id)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as
        | { ok: true; state: InsightState; content: T | null; generatedAt: string | null }
        | { ok: false; message: string };
      if (!('ok' in json) || !json.ok) {
        setView((prev) => ({ ...prev, refreshing: false }));
        return;
      }
      setView({
        state: json.state,
        content: json.content,
        generatedAt: json.generatedAt,
        refreshing: false,
      });
    } catch (err) {
      console.warn('[useLiveInsight] refresh failed', err);
      setView((prev) => ({ ...prev, refreshing: false }));
    }
  }, [args.type, args.id]);

  useRealtimeEventOfType(args.tenantId, 'ai.summary.updated', (event) => {
    if (event.entityType !== args.type) return;
    if (event.entityId !== args.id) return;
    // Idempotence: if the incoming `generatedAt` is older or equal to
    // what we already show, ignore. Protects against late replays.
    if (view.generatedAt && event.generatedAt <= view.generatedAt) return;
    void refresh();
  });

  return view;
}
