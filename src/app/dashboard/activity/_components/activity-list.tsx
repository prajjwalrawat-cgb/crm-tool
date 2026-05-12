import { Activity } from 'lucide-react';

import { formatActivity, formatRelativeTime } from '@/lib/activity/format';
import type { ActivityRow } from '@/lib/activity/queries';
import { cn } from '@/lib/utils';

export function ActivityList({
  rows,
  emptyMessage = 'No activity yet — create or edit a record to populate the feed.',
}: {
  rows: ActivityRow[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
        <Activity className="mx-auto h-6 w-6 text-slate-400" aria-hidden />
        <p className="mt-2 text-[12px] text-slate-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ol className="divide-y divide-slate-100">
      {rows.map((row) => (
        <ActivityListItem key={row.id} row={row} />
      ))}
    </ol>
  );
}

function ActivityListItem({ row }: { row: ActivityRow }) {
  const formatted = formatActivity(row);
  return (
    <li className="flex items-center gap-2.5 py-1.5 text-[12.5px]">
      <ActivityAvatar row={row} />
      <div className="min-w-0 flex-1">
        <p className="truncate">{formatted.sentence}</p>
        {formatted.detail ? (
          <p className="truncate text-[10.5px] text-slate-500">
            {formatted.detail}
          </p>
        ) : null}
      </div>
      <ActionPill action={row.action} />
      <span className="shrink-0 text-[10px] tabular-nums text-slate-400">
        {formatRelativeTime(row.createdAt)}
      </span>
    </li>
  );
}

function ActivityAvatar({ row }: { row: ActivityRow }) {
  const initial = (row.actor?.displayName?.[0] ?? '?').toUpperCase();
  if (row.actor?.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={row.actor.imageUrl}
        alt=""
        className="h-5 w-5 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-medium text-slate-600">
      {initial}
    </span>
  );
}

const ACTION_STYLES: Record<string, string> = {
  created: 'bg-emerald-100 text-emerald-700',
  updated: 'bg-blue-100 text-blue-700',
  deleted: 'bg-red-100 text-red-700',
  restored: 'bg-amber-100 text-amber-800',
  stage_changed:
    'bg-indigo-100 text-indigo-700',
  invited: 'bg-blue-100 text-blue-700',
  invitation_revoked:
    'bg-slate-100 text-slate-700',
  member_removed: 'bg-red-100 text-red-700',
  role_changed:
    'bg-indigo-100 text-indigo-700',
};

function ActionPill({ action }: { action: string }) {
  const cls = ACTION_STYLES[action] ?? ACTION_STYLES.updated;
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        cls,
      )}
    >
      {action.replace(/_/g, ' ')}
    </span>
  );
}
