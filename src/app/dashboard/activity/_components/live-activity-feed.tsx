'use client';

import { useCallback, useMemo, useState } from 'react';

import { useRealtimeEvents } from '@/hooks/use-realtime-events';
import type { ActivityRow } from '@/lib/activity/queries';
import type { PageSize } from '@/lib/pagination/page-size';
import type { RealtimeEvent, SerializedActivity } from '@/lib/realtime/events';

import { PaginationControls } from '../../_components/pagination-controls';
import { ActivityList } from './activity-list';

/**
 * Soft cap on the local feed so a long-running tab doesn't grow the row
 * array without bound. The server-side query already limits its initial
 * fetch (50 on the dashboard, 100 on /dashboard/activity); this is a
 * defense for the realtime tail.
 */
const SOFT_CAP = 200;

function deserializeActivity(s: SerializedActivity): ActivityRow {
  return {
    id: s.id,
    tenantId: s.tenantId,
    actorUserId: s.actorUserId,
    entityType: s.entityType,
    entityId: s.entityId,
    action: s.action,
    metadata: s.metadata,
    createdAt: new Date(s.createdAt),
    actor: s.actor,
  };
}

export function LiveActivityFeed({
  tenantId,
  initialRows,
  emptyMessage,
  nextCursor,
  pageSize,
  liveUpdates = true,
}: {
  tenantId: string;
  initialRows: ActivityRow[];
  emptyMessage?: string;
  /** When omitted (e.g. dashboard preview), pagination controls hide. */
  nextCursor?: string | null;
  pageSize?: PageSize;
  /**
   * Whether incoming realtime rows should be prepended. False on any
   * cursor page: a row created now belongs at the head of page 1, not
   * inside a window that was keyset-bounded before it existed.
   */
  liveUpdates?: boolean;
}) {
  // The page's rows are owned by the server — pagination is URL-driven,
  // so every Next/Prev/page-size change re-renders this component with a
  // fresh `initialRows`. Seeding `useState` from that prop would latch
  // the first page forever (React keeps the state of a component that
  // stays mounted across a soft navigation), which is exactly what made
  // the controls look dead. So state holds ONLY the realtime tail, and
  // it resets whenever the server hands us a different page.
  const [liveRows, setLiveRows] = useState<ActivityRow[]>([]);
  const [renderedPage, setRenderedPage] = useState(initialRows);
  if (renderedPage !== initialRows) {
    setRenderedPage(initialRows);
    if (liveRows.length > 0) setLiveRows([]);
  }

  const handleEvent = useCallback(
    (event: RealtimeEvent) => {
      if (!liveUpdates) return;
      if (event.type !== 'activity.recorded') return;
      const incoming = deserializeActivity(event.entry);
      setLiveRows((prev) => {
        // Idempotent: skip if we already have this id (the SSE dedup set
        // also handles this, but the belt-and-suspenders check is cheap and
        // protects against future event-replay scenarios).
        if (prev.some((r) => r.id === incoming.id)) return prev;
        const next = [incoming, ...prev];
        if (next.length > SOFT_CAP) next.length = SOFT_CAP;
        return next;
      });
    },
    [liveUpdates],
  );

  useRealtimeEvents(tenantId, handleEvent);

  const rows = useMemo(() => {
    if (liveRows.length === 0) return initialRows;
    // A live row can also arrive in the next server page (create an
    // activity, then hit Next) — the server copy wins on id.
    const onPage = new Set(initialRows.map((r) => r.id));
    const merged = [...liveRows.filter((r) => !onPage.has(r.id)), ...initialRows];
    return merged.length > SOFT_CAP ? merged.slice(0, SOFT_CAP) : merged;
  }, [liveRows, initialRows]);

  if (typeof pageSize === 'undefined') {
    return <ActivityList rows={rows} emptyMessage={emptyMessage} />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <ActivityList rows={rows} emptyMessage={emptyMessage} />
      <PaginationControls
        basePath="/dashboard/activity"
        nextCursor={nextCursor ?? null}
        size={pageSize}
        visibleCount={rows.length}
      />
    </div>
  );
}
