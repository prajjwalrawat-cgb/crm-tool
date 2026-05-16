import { Activity } from 'lucide-react';
import Link from 'next/link';

import { formatActivity, formatRelativeTime } from '@/lib/activity/format';
import type { ActivityRow } from '@/lib/activity/queries';
import { formatDateTime } from '@/lib/dates/format';
import { cn } from '@/lib/utils';

/**
 * Premium activity timeline. Each row leads with the actor (avatar +
 * name in stronger weight), then a humanized event sentence, with the
 * action category surfaced as a tinted pill on the right and a stable
 * relative timestamp far right. Entity references render as clickable
 * pills when we can resolve them, so the feed becomes a navigation
 * surface, not just a log.
 */
export function ActivityList({
  rows,
  emptyMessage = 'No activity yet — create or edit a record to populate the feed.',
}: {
  rows: ActivityRow[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center">
        <Activity className="mx-auto h-7 w-7 text-slate-400" aria-hidden />
        <p className="mt-3 text-[12.5px] text-slate-500">{emptyMessage}</p>
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

const ENTITY_HREF: Partial<
  Record<ActivityRow['entityType'], (id: string) => string>
> = {
  deal: (id) => `/dashboard/deals/${id}`,
  company: (id) => `/dashboard/companies/${id}`,
  contact: (id) => `/dashboard/contacts/${id}`,
};

function ActivityListItem({ row }: { row: ActivityRow }) {
  const formatted = formatActivity(row);
  const actorName = row.actor?.displayName ?? 'Someone';
  const isAutomation = row.action === 'automation_note' || !row.actorUserId;
  const absoluteTimestamp = formatDateTime(row.createdAt);
  const entityHref = ENTITY_HREF[row.entityType]?.(row.entityId);
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const entityName =
    typeof meta.name === 'string'
      ? meta.name
      : typeof meta.taskTitle === 'string'
        ? meta.taskTitle
        : null;

  return (
    <li className="group flex items-start gap-3 px-1 py-2.5 transition-colors hover:bg-slate-50/60">
      <ActivityAvatar row={row} isAutomation={isAutomation} />

      <div className="min-w-0 flex-1 leading-snug">
        <p className="text-[13px] text-slate-800">
          {isAutomation ? (
            <span className="font-semibold text-slate-700">Automation</span>
          ) : (
            <span className="font-semibold text-slate-900">{actorName}</span>
          )}{' '}
          <span className="text-slate-600">
            {stripActorPrefix(formatted.sentence, actorName)}
          </span>
          {entityHref && entityName ? (
            <>
              {' '}
              <Link
                href={entityHref}
                className="inline-flex items-center rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10.5px] font-medium text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700"
              >
                {entityName}
              </Link>
            </>
          ) : null}
        </p>
        {formatted.detail ? (
          <p className="mt-0.5 truncate text-[11.5px] text-slate-500">
            {formatted.detail}
          </p>
        ) : null}
      </div>

      <ActionPill action={row.action} />
      <span
        title={absoluteTimestamp}
        className="shrink-0 cursor-default text-[11px] tabular-nums text-slate-400"
      >
        {formatRelativeTime(row.createdAt)}
      </span>
    </li>
  );
}

/**
 * `formatActivity` prefixes the sentence with the actor name. The new
 * layout already renders the actor as a strong span, so strip the prefix
 * from the sentence to avoid "Varad Varad created…" double-rendering.
 */
function stripActorPrefix(sentence: string, actorName: string): string {
  if (sentence.startsWith(actorName + ' ')) {
    return sentence.slice(actorName.length + 1);
  }
  if (sentence.startsWith('Automation: ')) return sentence.slice('Automation: '.length);
  if (sentence.startsWith('Someone ')) return sentence.slice('Someone '.length);
  return sentence;
}

function ActivityAvatar({
  row,
  isAutomation,
}: {
  row: ActivityRow;
  isAutomation: boolean;
}) {
  if (isAutomation) {
    return (
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold uppercase tracking-wide text-indigo-700"
        aria-hidden
        title="Automation"
      >
        AI
      </span>
    );
  }
  const initial = (row.actor?.displayName?.[0] ?? '?').toUpperCase();
  if (row.actor?.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={row.actor.imageUrl}
        alt=""
        className="mt-0.5 h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
      />
    );
  }
  return (
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
      {initial}
    </span>
  );
}

const ACTION_STYLES: Record<string, string> = {
  created: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  updated: 'bg-blue-50 text-blue-700 ring-blue-200',
  deleted: 'bg-red-50 text-red-700 ring-red-200',
  restored: 'bg-amber-50 text-amber-700 ring-amber-200',
  stage_changed: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  invited: 'bg-blue-50 text-blue-700 ring-blue-200',
  invitation_revoked: 'bg-slate-100 text-slate-600 ring-slate-200',
  member_removed: 'bg-red-50 text-red-700 ring-red-200',
  role_changed: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  owner_changed: 'bg-violet-50 text-violet-700 ring-violet-200',
  email_sent: 'bg-sky-50 text-sky-700 ring-sky-200',
  email_failed: 'bg-rose-50 text-rose-700 ring-rose-200',
  task_completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  automation_note: 'bg-purple-50 text-purple-700 ring-purple-200',
};

function ActionPill({ action }: { action: string }) {
  const cls = ACTION_STYLES[action] ?? ACTION_STYLES.updated;
  return (
    <span
      className={cn(
        'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1',
        cls,
      )}
    >
      {action.replace(/_/g, ' ')}
    </span>
  );
}
