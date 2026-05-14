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
import {
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { toast } from 'sonner';

import type { TaskComment } from '@/db/schema';
import type { TaskRow } from '@/lib/tasks/queries';
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
} from '@/lib/tasks/filters';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { ComposeEmailLauncher } from '../../_components/compose-email-launcher';
import { Drawer } from '../../_components/drawer';
import { TeammatePicker } from '../../_components/teammate-picker';
import {
  softDeleteTaskAction,
  toggleTaskCompletedAction,
  updateTaskFieldsAction,
} from '../actions';
import { loadTaskCommentsAction } from '../comments-actions';
import { TaskComments } from './task-comments';

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
 * Editable task workspace. Title and description are inline-edited
 * (click to focus, blur or Cmd+Enter saves). Priority + status cycle
 * via the badge buttons. Due date + assignee have dedicated controls.
 *
 * All saves go through the partial-update `updateTaskFieldsAction`
 * which logs activity per change and best-effort fires notifications
 * post-commit. Failures surface as toast errors; the row stays
 * editable so the user can retry.
 */
export function TaskDetailDrawer({
  task,
  teammates,
  currentUserId,
  onClose,
}: {
  task: (TaskRow & { __pending?: boolean }) | null;
  teammates: Teammate[];
  currentUserId: string;
  onClose: () => void;
}) {
  const open = task !== null;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={task?.title ?? 'Task'}
      description={
        task ? `Created ${dateFormatter.format(new Date(task.createdAt))}` : undefined
      }
    >
      {task ? (
        <DrawerBody
          // Key by task id so switching tasks resets local edit state.
          key={task.id}
          task={task}
          teammates={teammates}
          currentUserId={currentUserId}
          onClose={onClose}
        />
      ) : null}
    </Drawer>
  );
}

function DrawerBody({
  task,
  teammates,
  currentUserId,
  onClose,
}: {
  task: TaskRow;
  teammates: Teammate[];
  currentUserId: string;
  onClose: () => void;
}) {
  const [pending, start] = useTransition();
  // Comments load on drawer open. They live below the metadata block;
  // an empty initial array shows the "no comments yet" placeholder
  // until the load resolves (usually one network round-trip).
  const [comments, setComments] = useState<TaskComment[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadTaskCommentsAction(task.id).then((result) => {
      if (cancelled) return;
      if (result.ok) setComments(result.comments);
    });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const assignee = task.assignedUserId
    ? teammates.find((t) => t.id === task.assignedUserId) ?? null
    : null;
  const creator = task.createdBy
    ? teammates.find((t) => t.id === task.createdBy) ?? null
    : null;
  const entityHref =
    task.entityType && task.entityId
      ? ENTITY_HREF[task.entityType as 'deal' | 'company' | 'contact']?.(task.entityId) ??
        null
      : null;

  function patch<K extends 'title' | 'description' | 'priority' | 'status' | 'assignedUserId' | 'dueDate'>(
    field: K,
    value: Parameters<typeof updateTaskFieldsAction>[0][K],
  ) {
    start(async () => {
      const result = await updateTaskFieldsAction({
        id: task.id,
        [field]: value,
      });
      if (!result.ok) toast.error(result.message);
    });
  }

  function cyclePriority() {
    const idx = PRIORITY_CYCLE.indexOf(task.priority);
    patch('priority', PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length]!);
  }
  function cycleStatus() {
    const idx = STATUS_CYCLE.indexOf(task.status as (typeof STATUS_CYCLE)[number]);
    patch(
      'status',
      idx === -1
        ? STATUS_CYCLE[0]!
        : STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]!,
    );
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
      <InlineTitleField
        initialValue={task.title}
        onSave={(v) => patch('title', v)}
      />

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
        {task.dueDate ? <DueChip dueDate={task.dueDate} /> : null}
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden />
        ) : null}
      </div>

      <section>
        <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
          Description
        </h3>
        <InlineDescriptionField
          initialValue={task.description ?? ''}
          onSave={(v) => patch('description', v.length === 0 ? null : v)}
        />
      </section>

      <section className="grid grid-cols-2 gap-2 text-[12px]">
        <AssigneeField
          assignee={assignee}
          assignedUserIdRaw={task.assignedUserId}
          teammates={teammates}
          currentUserId={currentUserId}
          onChange={(id) => patch('assignedUserId', id)}
        />
        <DetailCell label="Creator" icon={<User className="h-3.5 w-3.5" aria-hidden />}>
          {creator?.displayName ?? task.createdBy ?? '(system)'}
        </DetailCell>
        <DueDateField
          value={task.dueDate}
          onChange={(v) => patch('dueDate', v)}
        />
        <DetailCell label="Updated">
          {dateTimeFormatter.format(new Date(task.updatedAt))}
        </DetailCell>
      </section>

      {entityHref && task.linkedName && task.entityType && task.entityId ? (
        <section>
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Linked to
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={entityHref}
              className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-indigo-700"
            >
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                {task.entityType}
              </span>
              <span className="truncate">{task.linkedName}</span>
            </Link>
            <ComposeEmailLauncher
              entityType={task.entityType as 'deal' | 'company' | 'contact'}
              entityId={task.entityId}
              entityLabel={task.linkedName}
              canSend={true}
            />
          </div>
          <p className="mt-1 text-[10.5px] text-slate-500">
            Email sends attach to the linked {task.entityType} and appear on its
            timeline.
          </p>
        </section>
      ) : null}

      <TaskComments
        taskId={task.id}
        initialComments={comments}
        teammates={teammates}
        currentUserId={currentUserId}
      />

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

function InlineTitleField({
  initialValue,
  onSave,
}: {
  initialValue: string;
  onSave: (next: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed.length === 0) {
      setValue(initialValue);
      return;
    }
    if (trimmed !== initialValue) {
      onSave(trimmed);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setValue(initialValue);
            setEditing(false);
          }
        }}
        maxLength={280}
        className="w-full rounded-md border border-indigo-300 bg-white px-2 py-1 text-[15px] font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-full rounded-md px-2 py-1 text-left text-[15px] font-semibold text-slate-900 transition hover:bg-slate-50"
      title="Click to edit"
    >
      {value || <span className="text-slate-400">Untitled task</span>}
    </button>
  );
}

function InlineDescriptionField({
  initialValue,
  onSave,
}: {
  initialValue: string;
  onSave: (next: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [editing, setEditing] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    if (editing) textRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed !== initialValue.trim()) {
      onSave(trimmed);
    }
  }

  if (editing) {
    return (
      <textarea
        ref={textRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setValue(initialValue);
            setEditing(false);
          }
        }}
        rows={4}
        maxLength={4000}
        placeholder="Add context, links, expected outcome… (⌘⏎ to save, Esc to cancel)"
        className="w-full resize-y rounded-md border border-indigo-300 bg-white px-3 py-2 text-[12.5px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        'w-full rounded-md px-3 py-2 text-left text-[12.5px] leading-relaxed transition hover:bg-slate-50',
        value.trim() ? 'text-slate-700' : 'text-slate-400',
      )}
      title="Click to edit"
    >
      {value.trim() || 'Click to add a description'}
    </button>
  );
}

function DueDateField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        <Calendar className="h-3.5 w-3.5" aria-hidden />
        Due
      </div>
      <input
        type="date"
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v.length === 0 ? null : v);
        }}
        className="mt-1 w-full rounded border border-transparent bg-transparent px-0 py-0 text-slate-700 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      />
    </div>
  );
}

function AssigneeField({
  assignee,
  assignedUserIdRaw,
  teammates,
  currentUserId,
  onChange,
}: {
  assignee: Teammate | null;
  assignedUserIdRaw: string | null;
  teammates: Teammate[];
  currentUserId: string;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const displayName = assignee?.displayName ?? assignedUserIdRaw ?? null;

  return (
    <div className="relative rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          <User className="h-3.5 w-3.5" aria-hidden />
          Assignee
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] font-medium text-indigo-600 hover:text-indigo-500"
        >
          {displayName ? 'Change' : 'Assign'}
        </button>
      </div>
      <div className="mt-1 truncate text-slate-700">
        {displayName ?? <span className="text-slate-400">Unassigned</span>}
      </div>
      <TeammatePicker
        open={open}
        onOpenChange={setOpen}
        teammates={teammates}
        currentUserId={currentUserId}
        selectedId={assignedUserIdRaw}
        onSelect={(t) => {
          setOpen(false);
          onChange(t.id);
        }}
        onUnassign={() => {
          setOpen(false);
          onChange(null);
        }}
      />
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
  const diffDays = Math.round(
    (due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
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
