'use client';

import {
  Activity,
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  CheckSquare,
  Filter,
  Mail,
  MessageCircle,
  Phone,
  StickyNote,
  UserCog,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';

import { formatActivity } from '@/lib/activity/format';
import type { ActivityRow } from '@/lib/activity/queries';
import {
  commentPreview,
  parseMentions,
} from '@/lib/comments/mentions';
import type { TimelineItem } from '@/lib/timeline/queries';
import { RelativeTime } from '@/lib/dates/relative-time';
import { cn } from '@/lib/utils';

import { EmailRetryButton } from './email-retry-button';

/**
 * Unified per-entity timeline. Three feeds merged:
 *   - activity_logs (audit stream)
 *   - notes (operational memory)
 *   - comments (collaboration)
 *
 * Filter chips show one category at a time. "All" merges everything.
 * Each item gets a single-color icon and chrome that matches the
 * existing intel-widget vocabulary so the page reads consistently.
 */

type FilterMode =
  | 'all'
  | 'activity'
  | 'note'
  | 'comment'
  | 'email'
  | 'call'
  | 'meeting'
  | 'stage'
  | 'automation'
  | 'mine'
  | 'teammates';

const FILTER_LABEL: Record<FilterMode, string> = {
  all: 'All',
  activity: 'Activity',
  note: 'Notes',
  comment: 'Comments',
  email: 'Emails',
  call: 'Calls',
  meeting: 'Meetings',
  stage: 'Stage changes',
  automation: 'Automation',
  mine: 'Mine',
  teammates: 'Teammates',
};

const FILTER_ORDER: FilterMode[] = [
  'all',
  'mine',
  'teammates',
  'email',
  'comment',
  'note',
  'activity',
  'automation',
];

/** Chip set for the deal "Activity" section (section 3 of the spec). */
export const DEAL_ACTIVITY_FILTERS: FilterMode[] = [
  'all',
  'email',
  'call',
  'meeting',
  'stage',
  'note',
];

const ACTION_ICON: Record<string, LucideIcon> = {
  created: Activity,
  updated: Activity,
  deleted: Activity,
  restored: Activity,
  stage_changed: ArrowLeftRight,
  task_completed: CheckCircle2,
  owner_changed: UserCog,
  automation_note: Workflow,
  call_logged: Phone,
  meeting_logged: Users,
};

/**
 * Hydrated activity row used by the unified renderer. The server
 * resolves actor display names into `authorLookup`, mirroring the
 * existing activity-list behavior. We accept either:
 *   - rows hydrated server-side (with `actor` populated), or
 *   - raw rows we hydrate here against the same map
 * so callers can pass whichever is cheaper.
 */
export function EntityTimeline({
  items,
  authorLookup,
  currentUserId,
  title = 'Timeline',
  filterModes = FILTER_ORDER,
  headerAction,
  emptyLabel,
  groupByMonth = false,
  showSource = false,
}: {
  items: TimelineItem[];
  authorLookup: Record<string, string>;
  currentUserId: string;
  /** Section heading. Deal page passes "Activity". */
  title?: string;
  /** Which filter chips to show. Defaults to the full set. */
  filterModes?: FilterMode[];
  /** Rendered on the right of the header — e.g. the "Log activity" button. */
  headerAction?: ReactNode;
  emptyLabel?: string;
  /**
   * Break the flat feed into "September 2026" sections, newest month
   * first. Off by default: a single record's timeline is short enough to
   * scan whole, and the per-item relative time already carries the date.
   * The account feed turns it on because it merges every deal and
   * contact under the account, which is long enough that "when" stops
   * being obvious from position alone.
   */
  groupByMonth?: boolean;
  /**
   * Show which deal / contact each item came from. Only meaningful on a
   * feed that spans records — see `TimelineSource`.
   */
  showSource?: boolean;
}) {
  const [filter, setFilter] = useState<FilterMode>('all');

  // Item → author resolver. Reused by counts + filter + mine/teammates.
  const actorOf = (item: TimelineItem): string | null => {
    if (item.kind === 'comment') return item.row.authorUserId;
    if (item.kind === 'note') return item.row.authorUserId;
    if (item.kind === 'email') return item.row.actorUserId;
    return item.row.actorUserId;
  };
  const isAutomation = (item: TimelineItem): boolean =>
    item.kind === 'activity' &&
    (item.row.actorUserId === null || item.row.action === 'automation_note');

  const counts = useMemo(() => {
    const acc: Record<FilterMode, number> = {
      all: items.length,
      activity: 0,
      note: 0,
      comment: 0,
      email: 0,
      call: 0,
      meeting: 0,
      stage: 0,
      automation: 0,
      mine: 0,
      teammates: 0,
    };
    for (const item of items) {
      if (item.kind === 'activity') {
        if (isAutomation(item)) acc.automation++;
        else acc.activity++;
        if (item.row.action === 'call_logged') acc.call++;
        else if (item.row.action === 'meeting_logged') acc.meeting++;
        else if (item.row.action === 'stage_changed') acc.stage++;
      } else if (item.kind === 'note') {
        acc.note++;
      } else if (item.kind === 'email') {
        acc.email++;
      } else {
        acc.comment++;
      }
      const actor = actorOf(item);
      if (actor === currentUserId) acc.mine++;
      else if (actor) acc.teammates++;
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, currentUserId]);

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'comment') return items.filter((i) => i.kind === 'comment');
    if (filter === 'note') return items.filter((i) => i.kind === 'note');
    if (filter === 'email') return items.filter((i) => i.kind === 'email');
    if (filter === 'call')
      return items.filter(
        (i) => i.kind === 'activity' && i.row.action === 'call_logged',
      );
    if (filter === 'meeting')
      return items.filter(
        (i) => i.kind === 'activity' && i.row.action === 'meeting_logged',
      );
    if (filter === 'stage')
      return items.filter(
        (i) => i.kind === 'activity' && i.row.action === 'stage_changed',
      );
    if (filter === 'automation') return items.filter(isAutomation);
    if (filter === 'activity')
      return items.filter(
        (i) => i.kind === 'activity' && !isAutomation(i),
      );
    if (filter === 'mine')
      return items.filter((i) => actorOf(i) === currentUserId);
    if (filter === 'teammates')
      return items.filter((i) => {
        const a = actorOf(i);
        return a !== null && a !== currentUserId;
      });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, items, currentUserId]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-slate-900">{title}</h2>
          {headerAction}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Filter className="h-3 w-3 text-slate-400" aria-hidden />
          {filterModes.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setFilter(mode)}
              className={cn(
                'rounded-md px-1.5 py-0.5 text-[10.5px] font-medium transition',
                filter === mode
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700',
              )}
            >
              {FILTER_LABEL[mode]}
              <span className="ml-1 text-[9px] text-slate-400">
                {counts[mode]}
              </span>
            </button>
          ))}
        </div>
      </header>

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-[12px] text-slate-500">
          {filter === 'all'
            ? emptyLabel ?? 'No activity yet for this record.'
            : `No ${FILTER_LABEL[filter].toLowerCase()} yet.`}
        </p>
      ) : groupByMonth ? (
        <div className="flex flex-col gap-4">
          {groupItemsByMonth(filtered).map((group) => (
            <div key={group.key}>
              <h3 className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                {group.label}
                <span className="h-px flex-1 bg-slate-100" aria-hidden />
                <span className="tabular-nums">{group.items.length}</span>
              </h3>
              <ol className="flex flex-col gap-3">
                {group.items.map((item) => (
                  <TimelineRow
                    key={item.id}
                    item={item}
                    authorLookup={authorLookup}
                    currentUserId={currentUserId}
                    showSource={showSource}
                  />
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {filtered.map((item) => (
            <TimelineRow
              key={item.id}
              item={item}
              authorLookup={authorLookup}
              currentUserId={currentUserId}
              showSource={showSource}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Month buckets, newest first, preserving the newest-first order inside
 * each. `items` arrives already sorted, so one pass is enough — no
 * re-sorting, and no `Date` comparison beyond the bucket key.
 *
 * The key is UTC-pinned (`getUTCFullYear`/`getUTCMonth`) and the label
 * is formatted with `timeZone: 'UTC'`: this list is server-rendered and
 * then hydrated, so a viewer-local month boundary would put the same
 * item in two different buckets on the two passes.
 */
function groupItemsByMonth(
  items: TimelineItem[],
): Array<{ key: string; label: string; items: TimelineItem[] }> {
  const groups: Array<{ key: string; label: string; items: TimelineItem[] }> =
    [];
  let current: (typeof groups)[number] | null = null;
  for (const item of items) {
    const d = item.createdAt;
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (!current || current.key !== key) {
      current = { key, label: MONTH_FORMATTER.format(d), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function TimelineRow({
  item,
  authorLookup,
  currentUserId,
  showSource,
}: {
  item: TimelineItem;
  authorLookup: Record<string, string>;
  currentUserId: string;
  showSource: boolean;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <IconCircle item={item} />
      <div className="min-w-0 flex-1">
        <ItemBody
          item={item}
          authorLookup={authorLookup}
          currentUserId={currentUserId}
        />
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <RelativeTime
            date={item.createdAt}
            className="block text-[10px] tabular-nums text-slate-400"
          />
          {showSource && item.source ? (
            <Link
              href={
                item.source.type === 'deal'
                  ? `/dashboard/deals/${item.source.id}`
                  : `/dashboard/contacts/${item.source.id}`
              }
              className="max-w-[16rem] truncate rounded bg-slate-100 px-1 py-px text-[10px] font-medium text-slate-500 transition hover:bg-slate-200 hover:text-slate-700"
              title={item.source.name}
            >
              {item.source.type === 'deal' ? 'Deal' : 'Contact'} ·{' '}
              {item.source.name}
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function IconCircle({ item }: { item: TimelineItem }) {
  let Icon: LucideIcon = Activity;
  let tone = 'text-slate-500 bg-slate-100';
  if (item.kind === 'comment') {
    Icon = MessageCircle;
    tone = 'text-indigo-600 bg-indigo-50';
  } else if (item.kind === 'note') {
    Icon = StickyNote;
    tone = 'text-amber-600 bg-amber-50';
  } else if (item.kind === 'email') {
    if (item.row.status === 'failed') {
      Icon = AlertCircle;
      tone = 'text-rose-600 bg-rose-50';
    } else {
      Icon = Mail;
      tone = 'text-sky-600 bg-sky-50';
    }
  } else {
    const meta = (item.row.metadata ?? {}) as Record<string, unknown>;
    if (meta.automation || item.row.action === 'automation_note') {
      Icon = Workflow;
      tone = 'text-violet-600 bg-violet-50';
    } else if (item.row.action === 'call_logged') {
      Icon = Phone;
      tone = 'text-teal-600 bg-teal-50';
    } else if (item.row.action === 'meeting_logged') {
      Icon = Users;
      tone = 'text-cyan-600 bg-cyan-50';
    } else if (item.row.action === 'stage_changed') {
      Icon = ArrowLeftRight;
      tone = 'text-indigo-600 bg-indigo-50';
    } else if (item.row.entityType === 'task') {
      Icon = CheckSquare;
      tone = 'text-indigo-600 bg-indigo-50';
    } else {
      Icon = ACTION_ICON[item.row.action] ?? Activity;
      tone = 'text-slate-500 bg-slate-100';
    }
  }
  return (
    <span
      className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
        tone,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
    </span>
  );
}

function ItemBody({
  item,
  authorLookup,
  currentUserId,
}: {
  item: TimelineItem;
  authorLookup: Record<string, string>;
  currentUserId: string;
}) {
  if (item.kind === 'comment') {
    const author = authorLookup[item.row.authorUserId] ?? 'Teammate';
    return (
      <div>
        <p className="text-[12.5px] text-slate-700">
          <span className="font-semibold">{author}</span>
          <span className="text-slate-500"> commented</span>
        </p>
        <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-600">
          {parseMentions(item.row.body).map((run, i) =>
            run.kind === 'mention' ? (
              <span
                key={i}
                className={cn(
                  'rounded px-0.5 font-medium',
                  run.userId === currentUserId
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-indigo-50 text-indigo-700',
                )}
              >
                @{run.displayName}
              </span>
            ) : (
              <span key={i}>{run.text}</span>
            ),
          )}
        </p>
      </div>
    );
  }
  if (item.kind === 'note') {
    const author = authorLookup[item.row.authorUserId] ?? 'Teammate';
    return (
      <div>
        <p className="text-[12.5px] text-slate-700">
          <span className="font-semibold">{author}</span>
          <span className="text-slate-500"> added a note</span>
        </p>
        <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-600">
          {item.row.body.length > 280
            ? commentPreview(item.row.body, 280)
            : item.row.body}
        </p>
      </div>
    );
  }
  if (item.kind === 'email') {
    const author = authorLookup[item.row.actorUserId] ?? 'Teammate';
    const recipients = item.row.toRecipients.join(', ');
    const failed = item.row.status === 'failed';
    const preview =
      item.row.textBody.length > 240
        ? item.row.textBody.slice(0, 239) + '…'
        : item.row.textBody;
    return (
      <div>
        <p className="text-[12.5px] text-slate-700">
          <span className="font-semibold">{author}</span>
          <span className="text-slate-500">
            {failed ? ' tried to send' : ' sent'} email
          </span>
          {recipients ? (
            <>
              <span className="text-slate-500"> to </span>
              <span className="font-medium text-slate-700">{recipients}</span>
            </>
          ) : null}
        </p>
        <p className="mt-0.5 truncate text-[12.5px] font-medium text-slate-800">
          {item.row.subject}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-relaxed text-slate-500">
          {preview}
        </p>
        <p className="mt-0.5 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide">
          <span
            className={cn(
              'rounded px-1 py-0 font-medium',
              failed
                ? 'bg-rose-100 text-rose-700'
                : item.row.status === 'sent' ||
                    item.row.status === 'delivered'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-slate-100 text-slate-600',
            )}
          >
            {item.row.status}
          </span>
          <span className="text-slate-400">via {item.row.provider}</span>
          {failed && item.row.error ? (
            <span className="text-rose-600">· {item.row.error}</span>
          ) : null}
          {failed ? (
            <EmailRetryButton
              emailId={item.row.id}
              retryCount={item.row.retryCount}
            />
          ) : null}
        </p>
      </div>
    );
  }
  // activity
  const a = item.row;
  // Build an ActivityRow-shaped object so we can reuse formatActivity.
  const activityRow: ActivityRow = {
    ...a,
    actor: a.actorUserId
      ? {
          id: a.actorUserId,
          displayName: authorLookup[a.actorUserId] ?? 'Teammate',
          imageUrl: null,
        }
      : null,
  };
  const formatted = formatActivity(activityRow);
  return (
    <div>
      <p className="text-[12.5px] text-slate-700">{formatted.sentence}</p>
      {formatted.detail ? (
        <p className="mt-0.5 text-[11px] text-slate-500">{formatted.detail}</p>
      ) : null}
    </div>
  );
}
