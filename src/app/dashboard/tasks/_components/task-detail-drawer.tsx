'use client';

import {
  AlertTriangle,
  Calendar,
  Check,
  Loader2,
  Trash2,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { useTransition } from 'react';
import { toast } from 'sonner';

import type { TaskRow } from '@/lib/tasks/queries';
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
} from '@/lib/tasks/filters';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { Drawer } from '../../_components/drawer';
import {
  softDeleteTaskAction,
  toggleTaskCompletedAction,
  updateTaskFieldsAction,
} from '../actions';

const PRIORITY_CYCLE: TaskRow['priority'][] = [
  'low',
  'medium',
  'high',
  'urgent',
];
const STATUS_CYCLE: TaskRow['status'][] = [
  'todo',
  'in_progress',
  'completed',
];

const PRIORITY_TINT: Record<TaskRow['priority'], string> = {
  low: 'bg-slate-100 text-slate-700 ring-slate-200',
  medium: 'bg-blue-100 text-blue-800 ring-blue-200',
  high: 'bg-amber-100 text-amber-800 ring-amber-200',
  urgent: 'bg-rose-100 text-rose-800 ring-rose-200',
};

const STATUS_TINT: Record<TaskRow['status'], string> = {
  todo: 'bg-slate-100 text-slate-700 ring-slate-200',
  in_progress: 'bg-indigo-100 text-indigo-700 ring-indigo-200',
  completed: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 ring-slate-200',
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const ENTITY_HREF: Record<'deal' | 'company' | 'contact', (id: string) => string> = {
  deal: (id) => `/dashboard/deals/${id}`,
  company: (id) => `/dashboard/companies/${id}`,
  contact: (id) => `/dashboard/contacts/${id}`,
};

/**
 * Focused task detail drawer. Read + quick-edit surface (priority,
 * status, complete, delete). Comments / full timeline / inline title
 * edit are deferred — this drawer's job is to give clicking a task
 * something meaningful to open, with one-click access to the linked
 * entity for deeper context.
 */
export function TaskDetailDrawer({
  task,
  teammates,
  onClose,
}: {
  task: (TaskRow & { __pending?: boolean }) | null;
  teammates: Teammate[];
  onClose: () => void;
}) {
  const open = task !== null;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={task?.title ?? 'Task'}
      description={task ? `Created ${dateFormatter.format(new Date(task.createdAt))}` : undefined}
    >
      {task ? (
        <DrawerBody task={task} teammates={teammates} onClose={onClose} />
      ) : null}
    </Drawer>
  );
}

function DrawerBody({
  task,
  teammates,
  onClose,
}: {
  task: TaskRow;
  teammates: Teammate[];
  onClose: () => void;
}) {
  const [pending, start] = useTransition();
  const assignee = task.assignedUserId
    ? teammates.find((t) => t.id === task.assignedUserId) ?? null
    : null;
  const creator = task.createdBy
    ? teammates.find((t) => t.id === task.createdBy) ?? null
    : null;
  const entityHref =
    task.entityType && task.entityId
      ? ENTITY_HREF[task.entityType as 'deal' | 'company' | 'contact']?.(task.entityId) ?? null
      : null;

  function cyclePriority() {
    const idx = PRIORITY_CYCLE.indexOf(task.priority);
    const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length]!;
    start(async () => {
      const result = await updateTaskFieldsAction({ id: task.id, priority: next });
      if (!result.ok) toast.error(result.message);
    });
  }
  function cycleStatus() {
    const idx = STATUS_CYCLE.indexOf(task.status as (typeof STATUS_CYCLE)[number]);
    const next =
      idx === -1
        ? STATUS_CYCLE[0]!
        : STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]!;
    start(async () => {
      const result = await updateTaskFieldsAction({ id: task.id, status: next });
      if (!result.ok) toast.error(result.message);
    });
  }
  function toggleComplete() {
    const target = task.status !== 'completed';
    start(async () => {
      const result = await toggleTaskCompletedAction({ id: task.id, completed: target });
      if (!result.ok) toast.error(result.message);
    });
  }
  function remove() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Delete this task? This action soft-deletes the row.')
    ) {
      return;
    }
    start(async () => {
      const result = await softDeleteTaskAction(task.id);
      if (!result.ok) {
        toast.error(result.message);
      } else {
        toast.success('Task deleted');
        onClose();
      }
    });
  }

  const isCompleted = task.status === 'completed';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={cyclePriority}
          disabled={pending}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ring-1 transition hover:brightness-95',
            PRIORITY_TINT[task.priority],
            pending && 'cursor-wait opacity-70',
          )}
          title="Cycle priority"
        >
          {TASK_PRIORITY_LABELS[task.priority]}
        </button>
        <button
          type="button"
          onClick={cycleStatus}
          disabled={pending}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ring-1 transition hover:brightness-95',
            STATUS_TINT[task.status],
            pending && 'cursor-wait opacity-70',
          )}
          title="Cycle status"
        >
          {TASK_STATUS_LABELS[task.status]}
        </button>
        {task.dueDate ? (
          <DueChip dueDate={task.dueDate} />
        ) : null}
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden />
        ) : null}
      </div>

      {task.description ? (
        <section>
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Description
          </h3>
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-700">
            {task.description}
          </p>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-2 text-[12px]">
        <DetailCell label="Assignee" icon={<User className="h-3.5 w-3.5" aria-hidden />}>
          {assignee?.displayName ?? (task.assignedUserId ? task.assignedUserId : 'Unassigned')}
        </DetailCell>
        <DetailCell label="Creator" icon={<User className="h-3.5 w-3.5" aria-hidden />}>
          {creator?.displayName ?? task.createdBy ?? '(system)'}
        </DetailCell>
        <DetailCell label="Due" icon={<Calendar className="h-3.5 w-3.5" aria-hidden />}>
          {task.dueDate ? dateFormatter.format(new Date(task.dueDate + 'T00:00:00')) : '—'}
        </DetailCell>
        <DetailCell label="Updated">
          {dateTimeFormatter.format(new Date(task.updatedAt))}
        </DetailCell>
      </section>

      {entityHref && task.linkedName ? (
        <section>
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Linked to
          </h3>
          <Link
            href={entityHref}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-indigo-700"
          >
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              {task.entityType}
            </span>
            <span className="truncate">{task.linkedName}</span>
          </Link>
        </section>
      ) : null}

      <div className="sticky bottom-0 -mx-5 mt-2 flex items-center justify-between gap-2 border-t border-slate-100 bg-white px-5 py-3">
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-60"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </button>
        <button
          type="button"
          onClick={toggleComplete}
          disabled={pending}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition disabled:opacity-60',
            isCompleted
              ? 'bg-slate-600 hover:bg-slate-500'
              : 'bg-emerald-600 hover:bg-emerald-500',
          )}
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          {isCompleted ? 'Mark incomplete' : 'Mark complete'}
        </button>
      </div>
    </div>
  );
}

function DetailCell({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-slate-700">{children}</div>
    </div>
  );
}

function DueChip({ dueDate }: { dueDate: string }) {
  const due = new Date(dueDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  const overdue = diffDays < 0;
  const tone = overdue ? 'rose' : diffDays <= 3 ? 'amber' : 'slate';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
        tone === 'rose' && 'bg-rose-50 text-rose-700 ring-rose-200',
        tone === 'amber' && 'bg-amber-50 text-amber-700 ring-amber-200',
        tone === 'slate' && 'bg-slate-50 text-slate-600 ring-slate-200',
      )}
    >
      {overdue ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
      {dateFormatter.format(due)}
      {overdue ? ` · ${Math.abs(diffDays)}d overdue` : null}
    </span>
  );
}
