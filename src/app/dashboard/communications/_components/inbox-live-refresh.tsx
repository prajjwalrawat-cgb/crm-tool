'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { useRealtimeEvents } from '@/hooks/use-realtime-events';

/**
 * Lightweight client component that listens for inbox-relevant
 * realtime events and triggers a `router.refresh()` so the server-
 * rendered list re-fetches without a full navigation.
 *
 * Why not just maintain client state? The inbox already uses cursor
 * pagination + per-thread participant joins; replicating that on the
 * client would duplicate the query layer. Server-component refresh
 * via `router.refresh()` is the simplest approach — the SSE event
 * fires far less often than user navigation, so the cost is fine.
 *
 * Refresh is debounced (3s) so a burst of events from a workflow doesn't
 * thrash the route.
 */
export function InboxLiveRefresh({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      router.refresh();
    }, 3000);
  };

  useRealtimeEvents(tenantId, (event) => {
    switch (event.type) {
      case 'communication.thread.updated':
      case 'communication.message.sent':
      case 'communication.message.failed':
      case 'communication.draft.updated':
        schedule();
        break;
      default:
        return;
    }
  });

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return null;
}
