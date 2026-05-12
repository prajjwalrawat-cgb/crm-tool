'use client';

import {
  Bell,
  Briefcase,
  CheckCheck,
  CheckSquare,
  Sparkles,
  UserCog,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import type { Notification } from '@/db/schema';
import { useRealtimeEvents } from '@/hooks/use-realtime-events';
import { cn } from '@/lib/utils';

import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from '../notifications/actions';

/**
 * Topbar notification dropdown. Reads initial notifications from the
 * server (passed as props) and stays live via the existing tenant SSE
 * stream — same channel as activity/presence, filtered client-side
 * to this user's recipient id.
 *
 * The bell renders an unread-count badge; clicking opens a dropdown
 * with the 50 most-recent notifications grouped by recency. Clicking
 * a row navigates to the linked entity AND optimistically marks it
 * read.
 */

type NotificationItem = Omit<Notification, 'createdAt' | 'readAt' | 'metadata'> & {
  createdAt: Date;
  readAt: Date | null;
  metadata: Record<string, unknown>;
};

const TYPE_ICON: Record<string, LucideIcon> = {
  task_assigned: CheckSquare,
  task_completed: CheckSquare,
  task_due_soon: CheckSquare,
  deal_won: Sparkles,
  deal_lost: Briefcase,
  owner_changed: UserCog,
  comment_mention: Bell,
  automation_failed: Workflow,
};

const TYPE_TINT: Record<string, string> = {
  task_assigned: 'text-indigo-500',
  task_completed: 'text-emerald-500',
  task_due_soon: 'text-amber-500',
  deal_won: 'text-emerald-500',
  deal_lost: 'text-rose-500',
  owner_changed: 'text-blue-500',
  comment_mention: 'text-indigo-500',
  automation_failed: 'text-rose-500',
};

function notificationHref(n: NotificationItem): string | null {
  if (!n.entityType || !n.entityId) return null;
  switch (n.entityType) {
    case 'deal':
      return `/dashboard/deals/${n.entityId}`;
    case 'task':
      return `/dashboard/tasks?assignedToMe=1`;
    case 'company':
      return `/dashboard/companies`;
    case 'contact':
      return `/dashboard/contacts`;
    case 'workflow':
      return `/dashboard/workflows`;
    default:
      return null;
  }
}

export function NotificationBell({
  tenantId,
  currentUserId,
  initialNotifications,
}: {
  tenantId: string;
  currentUserId: string;
  initialNotifications: Notification[];
}) {
  const [items, setItems] = useState<NotificationItem[]>(() =>
    initialNotifications.map((n) => ({
      ...n,
      metadata: n.metadata as Record<string, unknown>,
    })),
  );
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  // Realtime: filter to events addressed to *this* user. Other users'
  // notifications on the same tenant channel get dropped.
  useRealtimeEvents(tenantId, (event) => {
    if (event.type !== 'notification.created') return;
    if (event.recipientUserId !== currentUserId) return;
    const incoming = event.notification;
    setItems((prev) => {
      if (prev.some((p) => p.id === incoming.id)) return prev;
      const next: NotificationItem = {
        id: incoming.id,
        tenantId: incoming.tenantId,
        recipientUserId: incoming.recipientUserId,
        actorUserId: incoming.actorUserId,
        type: incoming.type,
        title: incoming.title,
        subtitle: incoming.subtitle,
        entityType: incoming.entityType,
        entityId: incoming.entityId,
        metadata: incoming.metadata,
        readAt: incoming.readAt ? new Date(incoming.readAt) : null,
        createdAt: new Date(incoming.createdAt),
      };
      return [next, ...prev].slice(0, 100);
    });
  });

  // Close dropdown on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unreadCount = items.filter((n) => n.readAt === null).length;

  const handleMarkRead = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, readAt: new Date() } : n)),
    );
    startTransition(async () => {
      await markNotificationReadAction(id);
    });
  }, []);

  const handleMarkAllRead = useCallback(() => {
    setItems((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date() })),
    );
    startTransition(async () => {
      await markAllNotificationsReadAction();
    });
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          unreadCount > 0
            ? `${unreadCount} unread notifications`
            : 'Notifications'
        }
        className="relative inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unreadCount > 0 ? (
          <span className="absolute right-0.5 top-0.5 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-semibold leading-none text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-[22rem] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <header className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-[12px] font-semibold text-slate-800">
              Notifications
            </span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 ? (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  disabled={pending}
                  className="inline-flex items-center gap-1 text-[10.5px] font-medium text-indigo-600 hover:text-indigo-500 disabled:opacity-60"
                >
                  <CheckCheck className="h-3 w-3" aria-hidden />
                  Mark all read
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </header>

          <div className="max-h-[24rem] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px] text-slate-500">
                <Bell
                  className="mx-auto mb-2 h-5 w-5 text-slate-300"
                  aria-hidden
                />
                You&apos;re all caught up.
              </div>
            ) : (
              <ul className="flex flex-col">
                {items.map((n) => {
                  const Icon = TYPE_ICON[n.type] ?? Bell;
                  const tint = TYPE_TINT[n.type] ?? 'text-slate-500';
                  const href = notificationHref(n);
                  const content = (
                    <>
                      <Icon
                        className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', tint)}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            'truncate text-[12.5px] leading-tight',
                            n.readAt ? 'text-slate-600' : 'font-medium text-slate-900',
                          )}
                        >
                          {n.title}
                        </p>
                        {n.subtitle ? (
                          <p className="mt-0.5 truncate text-[11px] text-slate-500">
                            {n.subtitle}
                          </p>
                        ) : null}
                        <p className="mt-0.5 text-[10px] tabular-nums text-slate-400">
                          {relTime(n.createdAt)}
                        </p>
                      </div>
                      {n.readAt === null ? (
                        <span
                          className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500"
                          aria-label="Unread"
                        />
                      ) : null}
                    </>
                  );
                  const onSelect = () => {
                    if (n.readAt === null) handleMarkRead(n.id);
                    setOpen(false);
                  };
                  return (
                    <li
                      key={n.id}
                      className={cn(
                        'border-b border-slate-100 last:border-b-0',
                        n.readAt === null && 'bg-indigo-50/30',
                      )}
                    >
                      {href ? (
                        <Link
                          href={href}
                          onClick={onSelect}
                          className="flex items-start gap-2 px-3 py-2 transition hover:bg-slate-50"
                        >
                          {content}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={onSelect}
                          className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-slate-50"
                        >
                          {content}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function relTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
