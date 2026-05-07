import { formatActivity, formatRelativeTime } from '@/lib/activity/format';
import type { ActivityRow } from '@/lib/activity/queries';
import { cn } from '@/lib/utils';

export function ActivityList({
  rows,
  emptyMessage = 'No activity yet.',
}: {
  rows: ActivityRow[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400">
        {emptyMessage}
      </div>
    );
  }

  return (
    <ol className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
      {rows.map((row) => (
        <ActivityListItem key={row.id} row={row} />
      ))}
    </ol>
  );
}

function ActivityListItem({ row }: { row: ActivityRow }) {
  const formatted = formatActivity(row);
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <ActivityAvatar row={row} />
      <div className="min-w-0 flex-1">
        <p className="break-words">{formatted.sentence}</p>
        {formatted.detail ? (
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {formatted.detail}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          {formatRelativeTime(row.createdAt)}
        </p>
      </div>
      <ActionPill action={row.action} />
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
        className="h-7 w-7 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
      {initial}
    </span>
  );
}

const ACTION_STYLES: Record<string, string> = {
  created: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  updated: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  deleted: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  restored: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  stage_changed:
    'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300',
  invited: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  invitation_revoked:
    'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  member_removed: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  role_changed:
    'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300',
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
