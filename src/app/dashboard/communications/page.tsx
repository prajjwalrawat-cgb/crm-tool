import { AlertTriangle, Archive, Inbox, MailWarning, PenLine, Send, type LucideIcon } from 'lucide-react';
import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import {
  getInboxCounts,
  listInboxThreads,
} from '@/lib/communications/threads/queries';
import {
  findDraft,
  listMyDrafts,
} from '@/lib/communications/drafts/queries';
import { formatRelativeTime } from '@/lib/dates/format';
import type { ThreadStatus } from '@/db/schema';
import { requirePersonas } from '@/lib/personas/guards';
import { cn } from '@/lib/utils';

import { InboxLiveRefresh } from './_components/inbox-live-refresh';
import { QuickComposer } from './_components/quick-composer';

export const metadata = {
  title: 'Communications',
};

/**
 * Communications inbox shell (CP#16C-A).
 *
 * Scope of this checkpoint: read-only inbox view, no composer, no
 * AI, no attachments. The page renders a left-rail of folders +
 * a right-side list of threads.
 *
 * The list query is a single indexed scan on
 * `communication_threads(tenant_id, last_message_at DESC, id DESC)`
 * — no joins on the hot path, participants are batched separately.
 *
 * Filter is driven via `?view=` query param: 'inbox' (default),
 * 'sent', 'failed', 'drafts', 'archived'. The same query backs every
 * non-drafts view; drafts has its own query against
 * `communication_drafts`.
 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const VIEWS = ['inbox', 'sent', 'failed', 'drafts', 'archived'] as const;
type View = (typeof VIEWS)[number];

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // RBAC: inbox is tenant-shared in the current schema (threads
  // are keyed by email_address, not user_id), so a member would
  // see every thread. Until per-user inbox scoping ships, the
  // route is admin + manager only. Sales personas redirect to
  // /dashboard. The sidebar config also hides the link for sales.
  await requirePersonas(['admin', 'manager']);
  const sp = await searchParams;
  const viewParam = typeof sp.view === 'string' ? sp.view : 'inbox';
  const view: View = (VIEWS as readonly string[]).includes(viewParam)
    ? (viewParam as View)
    : 'inbox';

  return await withTenantSession(async ({ tenant, userId }) => {
    const counts = await getInboxCounts(tenant.id);
    // Always pre-fetch the user's "new" draft so the QuickComposer
    // mounts pre-filled if one exists. Cheap single-row query.
    const newDraft = await findDraft(tenant.id, userId, {
      contextKind: 'new',
    });

    // Each view has its own filter shape. Drafts uses a different
    // query entirely.
    let threads: Awaited<ReturnType<typeof listInboxThreads>>['items'] = [];
    let drafts: Awaited<ReturnType<typeof listMyDrafts>> = [];
    if (view === 'drafts') {
      drafts = await listMyDrafts(tenant.id, userId, { limit: 50 });
    } else {
      const filter: Parameters<typeof listInboxThreads>[1] = (() => {
        switch (view) {
          case 'failed':
            return { filter: { failedOnly: true } };
          case 'archived':
            return {
              filter: { status: 'archived' satisfies ThreadStatus },
            };
          case 'sent':
            // Sent shares the same backing data as 'inbox' in v1 —
            // every thread the tenant is involved in is visible
            // here. Separate views land in CP#16C-B with mailbox
            // filters.
            return { filter: { status: 'active' } };
          case 'inbox':
          default:
            return { filter: { status: 'active' } };
        }
      })();
      threads = (await listInboxThreads(tenant.id, filter)).items;
    }

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <InboxLiveRefresh tenantId={tenant.id} />
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-4 dark:border-[#1F1F1F]">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Communications
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              All threads across deals, companies, and contacts in one inbox.
              Drafts auto-save as you type; failed deliveries surface separately.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-right dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              Active
            </div>
            <div className="font-mono text-sm font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {counts.active}
            </div>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <Folders current={view} counts={counts} draftCount={drafts.length} />
          </aside>

          <div className="space-y-4">
            <section className="min-h-[28rem] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
              {view === 'drafts' ? (
                <DraftsList drafts={drafts} />
              ) : (
                <ThreadList view={view} items={threads} />
              )}
            </section>

            {view === 'inbox' && threads.length === 0 ? (
              <QuickComposer
                tenantId={tenant.id}
                currentUserId={userId}
                initialDraft={newDraft}
              />
            ) : null}
          </div>
        </div>
      </main>
    );
  });
}

/* ----- Folders rail ----- */

function Folders({
  current,
  counts,
  draftCount,
}: {
  current: View;
  counts: { active: number; unread: number; failed: number };
  draftCount: number;
}) {
  return (
    <nav aria-label="Inbox folders" className="flex flex-col gap-0.5">
      <FolderLink view="inbox" current={current} icon={Inbox} label="Inbox" badge={counts.unread || null} />
      <FolderLink view="sent" current={current} icon={Send} label="Sent" />
      <FolderLink view="drafts" current={current} icon={PenLine} label="Drafts" badge={draftCount || null} />
      <FolderLink
        view="failed"
        current={current}
        icon={MailWarning}
        label="Failed"
        badge={counts.failed || null}
        tone="danger"
      />
      <FolderLink view="archived" current={current} icon={Archive} label="Archived" />
    </nav>
  );
}

function FolderLink({
  view,
  current,
  icon: Icon,
  label,
  badge,
  tone = 'neutral',
}: {
  view: View;
  current: View;
  icon: LucideIcon;
  label: string;
  badge?: number | null;
  tone?: 'neutral' | 'danger';
}) {
  const active = view === current;
  return (
    <Link
      href={`/dashboard/communications?view=${view}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition',
        active
          ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]',
      )}
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {label}
      </span>
      {badge ? (
        <span
          className={cn(
            'rounded-full px-1.5 py-px font-mono text-[10px] tabular-nums',
            tone === 'danger'
              ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
              : 'bg-slate-100 text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]',
          )}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/* ----- Thread list ----- */

function ThreadList({
  view,
  items,
}: {
  view: View;
  items: Awaited<ReturnType<typeof listInboxThreads>>['items'];
}) {
  if (items.length === 0) {
    return (
      <div className="flex h-[28rem] flex-col items-center justify-center px-6 text-center">
        <AlertTriangle className="h-6 w-6 text-slate-300 dark:text-[#71717A]" aria-hidden />
        <p className="mt-3 text-[13px] font-medium text-slate-700 dark:text-[#FAFAFA]">
          {view === 'failed'
            ? 'No failed deliveries — your outbound mail is clean.'
            : view === 'archived'
              ? 'Nothing archived yet.'
              : 'No threads yet.'}
        </p>
        <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
          {view === 'inbox'
            ? 'New conversations land here once you send or receive mail.'
            : null}
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
      {items.map((t) => (
        <li key={t.id}>
          <Link
            href={`/dashboard/communications/${t.id}`}
            className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-[#111111]"
          >
            <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              {(t.participants[0]?.emailAddress ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    'truncate text-[12.5px]',
                    t.unreadCount > 0
                      ? 'font-semibold text-slate-900 dark:text-[#FAFAFA]'
                      : 'font-medium text-slate-700 dark:text-[#A1A1AA]',
                  )}
                >
                  {t.participants.map((p) => p.emailAddress).slice(0, 2).join(', ') ||
                    '(no recipients)'}
                </span>
                <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-slate-400 dark:text-[#71717A]">
                  {formatRelativeTime(new Date(t.lastMessageAt), new Date())}
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span
                  className={cn(
                    'truncate text-[12px]',
                    t.unreadCount > 0
                      ? 'font-medium text-slate-800 dark:text-[#FAFAFA]'
                      : 'text-slate-600 dark:text-[#A1A1AA]',
                  )}
                >
                  {t.subjectRaw || '(no subject)'}
                </span>
                {t.failedCount > 0 ? (
                  <span className="flex-shrink-0 rounded-full bg-rose-100 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                    Failed
                  </span>
                ) : null}
                {t.unreadCount > 0 ? (
                  <span className="flex-shrink-0 rounded-full bg-indigo-100 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                    {t.unreadCount} unread
                  </span>
                ) : null}
              </div>
              {t.messagePreview ? (
                <p className="mt-0.5 line-clamp-1 text-[11.5px] text-slate-500 dark:text-[#71717A]">
                  {t.messagePreview}
                </p>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ----- Drafts list ----- */

function DraftsList({
  drafts,
}: {
  drafts: Awaited<ReturnType<typeof listMyDrafts>>;
}) {
  if (drafts.length === 0) {
    return (
      <div className="flex h-[28rem] flex-col items-center justify-center px-6 text-center">
        <PenLine className="h-6 w-6 text-slate-300 dark:text-[#71717A]" aria-hidden />
        <p className="mt-3 text-[13px] font-medium text-slate-700 dark:text-[#FAFAFA]">
          No drafts yet.
        </p>
        <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
          Start composing a message and we&rsquo;ll save it here as you type.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
      {drafts.map((d) => (
        <li
          key={d.id}
          className="flex items-start gap-3 px-4 py-2.5"
        >
          <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]">
            <PenLine className="h-3 w-3" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[12.5px] font-medium text-slate-800 dark:text-[#FAFAFA]">
                {d.subject || '(no subject)'}
              </span>
              <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-slate-400 dark:text-[#71717A]">
                {formatRelativeTime(new Date(d.updatedAt), new Date())}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-1 text-[11.5px] text-slate-500 dark:text-[#71717A]">
              {d.toRecipients.length > 0
                ? `to: ${d.toRecipients.join(', ')}`
                : 'no recipients yet'}
            </p>
            {d.bodyText ? (
              <p className="mt-0.5 line-clamp-1 text-[11.5px] text-slate-500 dark:text-[#71717A]">
                {d.bodyText}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
