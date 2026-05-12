'use client';

import { useCallback, useState } from 'react';

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
}: {
  tenantId: string;
  initialRows: ActivityRow[];
  emptyMessage?: string;
  /** When omitted (e.g. dashboard preview), pagination controls hide. */
  nextCursor?: string | null;
  pageSize?: PageSize;
}) {
  const [rows, setRows] = useState<ActivityRow[]>(initialRows);

  const handleEvent = useCallback((event: RealtimeEvent) => {
    if (event.type !== 'activity.recorded') return;
    const incoming = deserializeActivity(event.entry);
    setRows((prev) => {
      // Idempotent: skip if we already have this id (the SSE dedup set
      // also handles this, but the belt-and-suspenders check is cheap and
      // protects against future event-replay scenarios).
      if (prev.some((r) => r.id === incoming.id)) return prev;
      const next = [incoming, ...prev];
      if (next.length > SOFT_CAP) next.length = SOFT_CAP;
      return next;
    });
  }, []);

  useRealtimeEvents(tenantId, handleEvent);

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
