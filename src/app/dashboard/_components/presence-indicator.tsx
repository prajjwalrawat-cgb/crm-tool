'use client';

import { useCallback, useState } from 'react';

import { useRealtimeEvents } from '@/hooks/use-realtime-events';
import type {
  PresenceMember,
  RealtimeEvent,
} from '@/lib/realtime/events';
import { cn } from '@/lib/utils';

const VISIBLE = 4;

/**
 * Displays the current set of users connected to this tenant's realtime
 * channel. Hydrated by the SSE handshake (which sends an initial presence
 * snapshot on connect) and updated on every join/leave broadcast.
 */
export function PresenceIndicator({ tenantId }: { tenantId: string }) {
  const [members, setMembers] = useState<PresenceMember[]>([]);

  const handle = useCallback((event: RealtimeEvent) => {
    if (event.type !== 'presence.snapshot') return;
    setMembers(event.members);
  }, []);

  useRealtimeEvents(tenantId, handle);

  if (members.length === 0) return null;

  const visible = members.slice(0, VISIBLE);
  const overflow = members.length - VISIBLE;

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm"
      aria-label={`${members.length} active`}
      title={members.map((m) => m.displayName ?? m.userId).join(', ')}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
        <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <div className="flex -space-x-1.5">
        {visible.map((m) => (
          <Avatar key={m.userId} member={m} />
        ))}
      </div>
      {overflow > 0 ? (
        <span className="ml-1 text-slate-500">+{overflow}</span>
      ) : null}
      <span className="hidden text-slate-500 sm:inline">
        {members.length} online
      </span>
    </div>
  );
}

function Avatar({ member }: { member: PresenceMember }) {
  const initial = (member.displayName?.[0] ?? member.userId[0] ?? '?').toUpperCase();
  if (member.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={member.imageUrl}
        alt=""
        className={cn(
          'h-5 w-5 rounded-full border-2 border-white object-cover',
        )}
      />
    );
  }
  return (
    <span
      className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-slate-200 text-[10px] font-medium text-slate-700"
      aria-label={member.displayName ?? member.userId}
    >
      {initial}
    </span>
  );
}
