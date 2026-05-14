'use client';

import { Check, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useTransition } from 'react';

import type { TaskRow } from '@/lib/tasks/queries';
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from '@/lib/tasks/filters';
import { cn } from '@/lib/utils';

import { updateTaskFieldsAction } from '../actions';

const PRIORITY_CYCLE: TaskRow['priority'][] = ['low', 'medium', 'high', 'urgent'];
const STATUS_CYCLE: TaskRow['status'][] = ['todo', 'in_progress', 'completed'];

const PRIORITY_TINT: Record<TaskRow['priority'], string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-800',
  urgent: 'bg-rose-100 text-rose-700',
};

const STATUS_TINT: Record<TaskRow['status'], string> = {
  todo: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-indigo-100 text-indigo-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

function dueLabel(dueDate: string | null): { text: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  if (!dueDate) return null;
  const due = new Date(dueDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round(
    (due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays < 0) {
    return {
      text: `${Math.abs(diffDays)}d overdue`,
      tone: 'overdue',
    };
  }
  if (diffDays === 0) return { text: 'Due today', tone: 'soon' };
  if (diffDays === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (diffDays <= 7) return { text: `Due in ${diffDays}d`, tone: 'soon' };
  return { text: dateFormatter.format(due), tone: 'normal' };
}

const LINKED_HREF: Record<'deal' | 'company' | 'contact', (id: string) => string> = {
  deal: (id) => `/dashboard/deals/${id}`,
  company: () => `/dashboard/companies`,
  contact: () => `/dashboard/contacts`,
};

export function TaskRowItem({
  task,
  canEdit,
  onToggle,
  onDelete,
}: {
  task: TaskRow & { __pending?: boolean };
  canEdit: boolean;
  onToggle: (completed: boolean) => void;
  onDelete: () => void;
}) {
  const completed = task.status === 'completed';
  const cancelled = task.status === 'cancelled';
  const due = dueLabel(task.dueDate);
  const isOptimistic = task.id.startsWith('optimistic-');
  const [inlinePending, startInline] = useTransition();
  const interactive = canEdit && !isOptimistic;

  function cyclePriority() {
    if (!interactive) return;
    const idx = PRIORITY_CYCLE.indexOf(task.priority);
    const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length]!;
    startInline(async () => {
      await updateTaskFieldsAction({ id: task.id, priority: next });
    });
  }

  function cycleStatus() {
    if (!interactive) return;
    const idx = STATUS_CYCLE.indexOf(task.status as (typeof STATUS_CYCLE)[number]);
    const next =
      idx === -1
        ? STATUS_CYCLE[0]!
        : STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]!;
    startInline(async () => {
      await updateTaskFieldsAction({ id: task.id, status: next });
    });
  }

  return (
    <li
      className={cn(
        'group flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-slate-50/70',
        task.__pending && 'opacity-60',
        (completed || cancelled) && 'opacity-70',
        due?.tone === 'overdue' && 'border-l-2 border-rose-400/70',
      )}
    >
      {canEdit && !isOptimistic ? (
        <button
          type="button"
          aria-label={completed ? 'Mark incomplete' : 'Mark complete'}
          onClick={() => onToggle(!completed)}
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
            completed
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : 'border-slate-300 bg-white hover:border-indigo-400',
          )}
        >
          {completed ? <Check className="h-3 w-3" aria-hidden /> : null}
        </button>
      ) : (
        <span
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50',
          )}
          aria-hidden
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p
            className={cn(
              'truncate text-[13px] font-medium text-slate-800',
              completed && 'line-through decoration-slate-300',
            )}
          >
            {task.title}
          </p>
          {task.__pending && !isOptimistic ? (
            <Loader2
              className="h-3 w-3 shrink-0 animate-spin text-slate-400"
              aria-hidden
            />
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <button
            type="button"
            onClick={cyclePriority}
            disabled={!interactive || inlinePending}
            title={interactive ? 'Cycle priority' : undefined}
            className={cn(
              'rounded px-1 py-0 font-medium uppercase tracking-wide transition',
              PRIORITY_TINT[task.priority],
              interactive
                ? 'cursor-pointer hover:brightness-95'
                : 'cursor-default',
              inlinePending && 'opacity-70',
            )}
          >
            {TASK_PRIORITY_LABELS[task.priority]}
          </button>
          <button
            type="button"
            onClick={cycleStatus}
            disabled={!interactive || inlinePending}
            title={interactive ? 'Cycle status' : undefined}
            className={cn(
              'rounded px-1 py-0 font-medium uppercase tracking-wide transition',
              STATUS_TINT[task.status],
              interactive
                ? 'cursor-pointer hover:brightness-95'
                : 'cursor-default',
              inlinePending && 'opacity-70',
            )}
          >
            {TASK_STATUS_LABELS[task.status]}
          </button>
          {due ? (
            <span
              className={cn(
                'rounded px-1 py-0 font-medium',
                due.tone === 'overdue'
                  ? 'bg-rose-100 text-rose-700'
                  : due.tone === 'soon'
                    ? 'bg-amber-100 text-amber-800'
                    : 'text-slate-500',
              )}
            >
              {due.text}
            </span>
          ) : null}
          {task.entityType && task.entityId && task.linkedName ? (
            <Link
              href={LINKED_HREF[task.entityType as 'deal' | 'company' | 'contact'](
                task.entityId,
              )}
              className="text-slate-500 hover:text-indigo-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {task.entityType}: {task.linkedName}
            </Link>
          ) : null}
        </div>
      </div>

      {canEdit && !isOptimistic ? (
        <button
          type="button"
          aria-label="Delete task"
          onClick={onDelete}
          className="rounded p-1 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}
