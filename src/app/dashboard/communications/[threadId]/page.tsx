import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Send,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getAIMode } from '@/lib/ai/config';
import { withTenantSession } from '@/lib/auth-guard';
import {
  listEventsForThread,
  listMessagesForThread,
} from '@/lib/communications/threads/messages';
import { getThreadById } from '@/lib/communications/threads/queries';
import { formatDateTime, formatRelativeTime } from '@/lib/dates/format';
import { getThreadSummaryInsight } from '@/lib/intelligence/runner';
import { cn } from '@/lib/utils';

import { LiveThreadSummaryCard } from '../../intelligence/_components/live-ai-card';
import { RelationshipHealthCard } from '../../_components/relationship-health-card';

export const metadata = {
  title: 'Thread',
};

type Params = Promise<{ threadId: string }>;

/**
 * Thread runtime view. Server-rendered chronological message list +
 * AI summary placeholder + relationship health card. Realtime live-
 * tail wiring lands as a client subscription in a follow-up.
 */
export default async function ThreadDetailPage({
  params,
}: {
  params: Params;
}) {
  const { threadId } = await params;
  return await withTenantSession(async ({ tenant, userId }) => {
    const thread = await getThreadById(tenant.id, threadId);
    if (!thread) notFound();

    const aiMode = getAIMode();
    const [messages, events, threadSummary] = await Promise.all([
      listMessagesForThread(tenant.id, threadId),
      listEventsForThread(tenant.id, threadId, { limit: 30 }),
      getThreadSummaryInsight(tenant.id, userId, threadId),
    ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/communications"
          className="inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:text-[#FAFAFA]"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All threads
        </Link>

        <header className="mt-3 mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-4 dark:border-[#1F1F1F]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              {thread.subjectRaw || '(no subject)'}
            </h1>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              {thread.participants
                .map((p) => p.emailAddress)
                .slice(0, 6)
                .join(' · ') || 'No participants yet'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {thread.unreadCount > 0 ? (
              <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                {thread.unreadCount} unread
              </span>
            ) : null}
            {thread.failedCount > 0 ? (
              <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                {thread.failedCount} failed
              </span>
            ) : null}
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <section>
            <MessagesTimeline messages={messages} />
            {events.length > 0 ? (
              <EventStrip events={events} />
            ) : null}
          </section>

          <aside className="space-y-3">
            <LiveThreadSummaryCard
              tenantId={tenant.id}
              threadId={threadId}
              title="AI thread summary"
              subtitle="Narrative, unresolved questions, and next actions"
              tone="info"
              summaryId={null}
              hideFeedback
              initial={threadSummary.content}
              initialState={threadSummary.state}
              initialGeneratedAt={threadSummary.generatedAt?.toISOString() ?? null}
              modeOverride={
                aiMode === 'disabled'
                  ? 'disabled'
                  : aiMode === 'mock'
                    ? 'mock'
                    : undefined
              }
            />
            {thread.entityType && thread.entityId ? (
              <RelationshipHealthCard
                tenantId={tenant.id}
                entityType={thread.entityType as 'deal' | 'company' | 'contact'}
                entityId={thread.entityId}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/40 p-3 text-[11.5px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
                This thread isn&rsquo;t linked to a CRM entity yet. Link it
                from a deal, contact, or company to enable relationship
                scoring.
              </div>
            )}

            <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                Thread stats
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-[11.5px]">
                <StatRow label="Messages" value={thread.messageCount} />
                <StatRow label="Failed" value={thread.failedCount} />
                <StatRow label="Unread" value={thread.unreadCount} />
                <StatRow
                  label="Last activity"
                  value={formatRelativeTime(
                    new Date(thread.lastMessageAt),
                    new Date(),
                  )}
                />
              </dl>
            </div>
          </aside>
        </div>
      </main>
    );
  });
}

/* ---------- Sub-components ---------- */

function MessagesTimeline({
  messages,
}: {
  messages: Awaited<ReturnType<typeof listMessagesForThread>>;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-[20rem] flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/40 text-center dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        <Send className="h-5 w-5 text-slate-300 dark:text-[#71717A]" aria-hidden />
        <p className="mt-2 text-[13px] font-medium text-slate-700 dark:text-[#FAFAFA]">
          No messages on this thread yet.
        </p>
        <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
          New sends will land here in chronological order.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {messages.map((m) => (
        <li
          key={m.id}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-2 dark:border-[#1F1F1F]">
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-medium text-slate-900 dark:text-[#FAFAFA]">
                {m.sender}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                to: {m.toRecipients.join(', ') || '—'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DeliveryPill kind={m.latestEventKind ?? m.status} />
              <span
                className="font-mono text-[10.5px] tabular-nums text-slate-400 dark:text-[#71717A]"
                title={formatDateTime(new Date(m.createdAt))}
              >
                {formatRelativeTime(new Date(m.createdAt), new Date())}
              </span>
            </div>
          </header>
          <div className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-700 dark:text-[#A1A1AA]">
            {m.textBody}
          </div>
        </li>
      ))}
    </ul>
  );
}

function DeliveryPill({ kind }: { kind: string }) {
  const variant: Record<
    string,
    { Icon: typeof CheckCircle2; cls: string; label: string }
  > = {
    sent: {
      Icon: Send,
      cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
      label: 'Sent',
    },
    delivered: {
      Icon: CheckCircle2,
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
      label: 'Delivered',
    },
    queued: {
      Icon: Clock,
      cls: 'bg-slate-100 text-slate-700 dark:bg-[#181818] dark:text-[#A1A1AA]',
      label: 'Queued',
    },
    sending: {
      Icon: Clock,
      cls: 'bg-slate-100 text-slate-700 dark:bg-[#181818] dark:text-[#A1A1AA]',
      label: 'Sending',
    },
    failed: {
      Icon: XCircle,
      cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
      label: 'Failed',
    },
    retried: {
      Icon: AlertTriangle,
      cls: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
      label: 'Retried',
    },
    bounced: {
      Icon: AlertTriangle,
      cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
      label: 'Bounced',
    },
    opened: {
      Icon: CheckCircle2,
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
      label: 'Opened',
    },
    clicked: {
      Icon: CheckCircle2,
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
      label: 'Clicked',
    },
    replied: {
      Icon: CheckCircle2,
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
      label: 'Replied',
    },
  };
  const v = variant[kind] ?? variant.sent!;
  const Icon = v.Icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide',
        v.cls,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {v.label}
    </span>
  );
}

function EventStrip({
  events,
}: {
  events: Awaited<ReturnType<typeof listEventsForThread>>;
}) {
  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-slate-50/40 p-3 dark:border-[#1F1F1F] dark:bg-[#111111]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        Event timeline
      </div>
      <ul className="mt-1.5 space-y-1">
        {events.slice(0, 10).map((e) => (
          <li
            key={e.id}
            className="flex items-center justify-between gap-2 text-[11px]"
          >
            <span className="flex items-center gap-1.5 text-slate-600 dark:text-[#A1A1AA]">
              <DeliveryPill kind={e.eventKind} />
              {e.provider ? (
                <span className="font-mono text-[9.5px] text-slate-400 dark:text-[#71717A]">
                  via {e.provider}
                </span>
              ) : null}
            </span>
            <span
              className="font-mono text-[9.5px] tabular-nums text-slate-400 dark:text-[#71717A]"
              title={formatDateTime(new Date(e.createdAt))}
            >
              {formatRelativeTime(new Date(e.createdAt), new Date())}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <dt className="text-slate-500 dark:text-[#A1A1AA]">{label}</dt>
      <dd className="font-mono font-medium tabular-nums text-slate-800 dark:text-[#FAFAFA]">
        {value}
      </dd>
    </div>
  );
}
