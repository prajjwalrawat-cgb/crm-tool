'use client';

import { CheckSquare, Loader2, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { Task } from '@/db/schema';
import { TASK_PRIORITY_LABELS } from '@/lib/tasks/filters';
import { cn } from '@/lib/utils';

import {
  createTaskAction,
  toggleTaskCompletedAction,
} from '../tasks/actions';

type TaskItem = Task & { __pending?: boolean };

const PRIORITY_TINT: Record<Task['priority'], string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-800',
  urgent: 'bg-rose-100 text-rose-700',
};

/**
 * Contextual tasks panel for an entity detail page. Renders linked
 * tasks sorted by:
 *   1. overdue
 *   2. due today
 *   3. upcoming
 *   4. completed (collapsible)
 *
 * Provides a quick-add input (Enter → optimistic create) and an
 * inline completion checkbox. The full task editor lives on the
 * dedicated /dashboard/tasks page; this panel covers the 80% case of
 * "I'm on a deal, jot down the next action."
 */
export function EntityTasksPanel({
  entityType,
  entityId,
  ownerId,
  currentUserId,
  initialTasks,
  canEdit,
}: {
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
  /** Default assignee for new tasks (the owning user of the entity). */
  ownerId: string | null;
  currentUserId: string;
  initialTasks: Task[];
  canEdit: boolean;
}) {
  const [tasks, setTasks] = useState<TaskItem[]>(initialTasks);
  const [draft, setDraft] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [pending, startTransition] = useTransition();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const openTasks = tasks
    .filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
    .sort(sortByUrgency);
  const completedTasks = tasks
    .filter((t) => t.status === 'completed')
    .sort((a, b) => +(b.completedAt ?? b.updatedAt) - +(a.completedAt ?? a.updatedAt));

  function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    const optimistic: TaskItem = {
      id: `optimistic-${crypto.randomUUID()}`,
      tenantId: '',
      title,
      description: null,
      status: 'todo',
      priority: 'medium',
      dueDate: null,
      assignedUserId: ownerId ?? currentUserId,
      createdBy: currentUserId,
      completedAt: null,
      entityType,
      entityId,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedBy: null,
      __pending: true,
    };
    setTasks((prev) => [optimistic, ...prev]);
    setDraft('');
    startTransition(async () => {
      const fd = new FormData();
      fd.set('title', title);
      fd.set('priority', 'medium');
      fd.set('status', 'todo');
      fd.set('entityType', entityType);
      fd.set('entityId', entityId);
      if (ownerId) fd.set('assignedUserId', ownerId);
      const result = await createTaskAction(fd);
      if (!result.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== optimistic.id));
        toast.error(result.message);
      } else {
        setTasks((prev) =>
          prev.map((t) => (t.id === optimistic.id ? result.task : t)),
        );
      }
    });
  }

  function handleToggle(task: TaskItem, completed: boolean) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id
          ? {
              ...t,
              status: completed ? 'completed' : 'todo',
              completedAt: completed ? new Date() : null,
              __pending: true,
            }
          : t,
      ),
    );
    startTransition(async () => {
      const result = await toggleTaskCompletedAction({
        id: task.id,
        completed,
      });
      if (!result.ok) toast.error(result.message);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id && result.ok
            ? { ...result.task, __pending: false }
            : t,
        ),
      );
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <CheckSquare className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">Tasks</h2>
        </div>
        <span className="text-[10px] tabular-nums text-slate-400">
          {openTasks.length} open · {completedTasks.length} done
        </span>
      </header>

      {canEdit ? (
        <form onSubmit={handleAdd} className="mb-3">
          <div className="flex items-center gap-2">
            <Plus className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a task — Enter to create"
              className="w-full bg-transparent text-[13px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
              disabled={pending}
            />
            {pending ? (
              <Loader2
                className="h-3 w-3 shrink-0 animate-spin text-slate-400"
                aria-hidden
              />
            ) : null}
          </div>
        </form>
      ) : null}

      {openTasks.length === 0 && completedTasks.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-[12px] text-slate-500">
          No tasks here yet. Type above to capture the next action.
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-slate-100">
            {openTasks.map((t) => (
              <TaskItemRow
                key={t.id}
                task={t}
                canEdit={canEdit}
                onToggle={() => handleToggle(t, true)}
                today={today}
              />
            ))}
          </ul>

          {completedTasks.length > 0 ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowCompleted((v) => !v)}
                className="text-[11px] font-medium text-slate-500 hover:text-slate-700"
              >
                {showCompleted ? '▾' : '▸'} Completed ({completedTasks.length})
              </button>
              {showCompleted ? (
                <ul className="mt-1 flex flex-col divide-y divide-slate-100">
                  {completedTasks.slice(0, 20).map((t) => (
                    <TaskItemRow
                      key={t.id}
                      task={t}
                      canEdit={canEdit}
                      onToggle={() => handleToggle(t, false)}
                      today={today}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function TaskItemRow({
  task,
  canEdit,
  onToggle,
  today,
}: {
  task: TaskItem;
  canEdit: boolean;
  onToggle: () => void;
  today: Date;
}) {
  const completed = task.status === 'completed';
  const isOptimistic = task.id.startsWith('optimistic-');
  const due = task.dueDate ? dueLabel(task.dueDate, today) : null;

  return (
    <li className="flex items-start gap-2 py-1.5">
      {canEdit && !isOptimistic ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={completed ? 'Mark incomplete' : 'Mark complete'}
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
            completed
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : 'border-slate-300 bg-white hover:border-indigo-400',
          )}
        >
          {completed ? <span className="text-[9px]">✓</span> : null}
        </button>
      ) : (
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50" />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-[12.5px] text-slate-800',
            completed && 'line-through decoration-slate-300 text-slate-500',
          )}
        >
          {task.title}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <span
            className={cn(
              'rounded px-1 py-0 font-medium uppercase tracking-wide',
              PRIORITY_TINT[task.priority],
            )}
          >
            {TASK_PRIORITY_LABELS[task.priority]}
          </span>
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
        </div>
      </div>
      {task.__pending && !isOptimistic ? (
        <Loader2 className="mt-1 h-3 w-3 shrink-0 animate-spin text-slate-400" aria-hidden />
      ) : null}
    </li>
  );
}

function sortByUrgency(a: TaskItem, b: TaskItem): number {
  const ad = a.dueDate ? new Date(a.dueDate + 'T00:00:00').getTime() : Infinity;
  const bd = b.dueDate ? new Date(b.dueDate + 'T00:00:00').getTime() : Infinity;
  if (ad !== bd) return ad - bd;
  const order = { urgent: 0, high: 1, medium: 2, low: 3 } as const;
  return order[a.priority] - order[b.priority];
}

function dueLabel(
  iso: string,
  today: Date,
): { text: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  const due = new Date(iso + 'T00:00:00');
  const diff = Math.round(
    (due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diff < 0)
    return { text: `${Math.abs(diff)}d overdue`, tone: 'overdue' };
  if (diff === 0) return { text: 'Due today', tone: 'soon' };
  if (diff === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (diff <= 7) return { text: `Due in ${diff}d`, tone: 'soon' };
  return {
    text: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    tone: 'normal',
  };
}
