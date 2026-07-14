'use client';

import {
  Building2,
  CheckSquare,
  CornerUpRight,
  Loader2,
  Mail,
  Phone,
  Plus,
  Repeat,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { Task, TaskType } from '@/db/schema';
import { TASK_PRIORITY_LABELS } from '@/lib/tasks/filters';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { createTaskAction, toggleTaskCompletedAction } from '../tasks/actions';

type TaskItem = Task & { __pending?: boolean };

const PRIORITY_DOT: Record<Task['priority'], string> = {
  low: 'bg-slate-300',
  medium: 'bg-blue-400',
  high: 'bg-amber-500',
  urgent: 'bg-rose-500',
};

const TYPE_ICON: Record<TaskType, LucideIcon> = {
  call: Phone,
  email: Mail,
  meeting: Users,
  internal: Building2,
  followup: CornerUpRight,
};

const TYPE_LABEL: Record<TaskType, string> = {
  call: 'Call',
  email: 'Email',
  meeting: 'Meeting',
  internal: 'Internal',
  followup: 'Follow-up',
};

const DEAL_STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'lead', label: 'Lead' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'hold', label: 'Hold' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

type Bucket = 'overdue' | 'today' | 'upcoming' | 'nodue';

/**
 * Contextual tasks panel for an entity detail page. Provides:
 *   - a fast quick-add (type title + Enter → optimistic bare task)
 *   - an opt-in expanded form (+ icon or Tab) with due date, assignee,
 *     type, priority, recurrence, and (deals only) a stage-blocking gate
 *   - collapsible groups: Overdue / Today / Upcoming / No due date / Done
 *   - an inline completion checkbox
 *
 * The full task editor lives on /dashboard/tasks; this panel covers the
 * "I'm on a deal, capture and schedule the next action" case.
 */
export function EntityTasksPanel({
  entityType,
  entityId,
  ownerId,
  currentUserId,
  initialTasks,
  canEdit,
  teammates,
}: {
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
  /** Default assignee for new tasks (the owning user of the entity). */
  ownerId: string | null;
  currentUserId: string;
  initialTasks: Task[];
  canEdit: boolean;
  /** Assignee options. When omitted, new tasks default to the owner. */
  teammates?: Teammate[];
}) {
  const [tasks, setTasks] = useState<TaskItem[]>(initialTasks);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const defaultAssignee = ownerId ?? currentUserId;
  // Structured-form state (only used while expanded).
  const [dueDate, setDueDate] = useState('');
  const [assignee, setAssignee] = useState(defaultAssignee);
  const [type, setType] = useState<TaskType | ''>('');
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [recurrence, setRecurrence] = useState<'' | 'daily' | 'weekly' | 'custom'>(
    '',
  );
  const [stageBlocking, setStageBlocking] = useState('');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const openTasks = tasks.filter(
    (t) => t.status !== 'completed' && t.status !== 'cancelled',
  );
  const completedTasks = tasks
    .filter((t) => t.status === 'completed')
    .sort(
      (a, b) =>
        +(b.completedAt ?? b.updatedAt) - +(a.completedAt ?? a.updatedAt),
    );

  const groups: Record<Bucket, TaskItem[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    nodue: [],
  };
  for (const t of openTasks) groups[bucketOf(t, today)].push(t);
  for (const b of Object.keys(groups) as Bucket[]) {
    groups[b].sort(sortByUrgency);
  }
  const overdueCount = groups.overdue.length;

  function resetForm() {
    setDraft('');
    setDueDate('');
    setAssignee(defaultAssignee);
    setType('');
    setPriority('medium');
    setRecurrence('');
    setStageBlocking('');
  }

  function submit() {
    const title = draft.trim();
    if (!title) return;
    const optimistic: TaskItem = {
      id: `optimistic-${crypto.randomUUID()}`,
      tenantId: '',
      title,
      description: null,
      status: 'todo',
      priority: expanded ? priority : 'medium',
      type: expanded && type ? type : null,
      recurrence: expanded && recurrence ? recurrence : null,
      stageBlocking: expanded && stageBlocking ? (stageBlocking as Task['stageBlocking']) : null,
      dueDate: expanded && dueDate ? dueDate : null,
      assignedUserId: expanded ? assignee : defaultAssignee,
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
    const snapshot = { ...optimistic };
    resetForm();
    setExpanded(false);
    startTransition(async () => {
      const fd = new FormData();
      fd.set('title', snapshot.title);
      fd.set('priority', snapshot.priority);
      fd.set('status', 'todo');
      fd.set('entityType', entityType);
      fd.set('entityId', entityId);
      if (snapshot.assignedUserId) fd.set('assignedUserId', snapshot.assignedUserId);
      if (snapshot.dueDate) fd.set('dueDate', snapshot.dueDate);
      if (snapshot.type) fd.set('type', snapshot.type);
      if (snapshot.recurrence) fd.set('recurrence', snapshot.recurrence);
      if (snapshot.stageBlocking) fd.set('stageBlocking', snapshot.stageBlocking);
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
      const result = await toggleTaskCompletedAction({ id: task.id, completed });
      if (!result.ok) {
        toast.error(result.message);
        // Roll back the optimistic flip.
        setTasks((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? { ...task, __pending: false }
              : t,
          ),
        );
        return;
      }
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id ? { ...result.task, __pending: false } : t,
        ),
      );
      // A completed recurring task spawns its next instance server-side;
      // surface it so the user sees the roll-forward without a reload.
      if (completed && result.task.recurrence) {
        toast.success('Recurring task rolled forward to next due date');
      }
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <CheckSquare className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">Tasks</h2>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] tabular-nums text-slate-400">
          {overdueCount > 0 ? (
            <span className="rounded bg-rose-100 px-1 py-0 font-semibold text-rose-700">
              {overdueCount} overdue
            </span>
          ) : null}
          {openTasks.length} open · {completedTasks.length} done
        </span>
      </header>

      {canEdit ? (
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-50/60 p-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setExpanded((v) => !v);
                inputRef.current?.focus();
              }}
              aria-label={expanded ? 'Collapse task details' : 'Add task details'}
              className="shrink-0 text-slate-400 hover:text-indigo-500"
            >
              {expanded ? (
                <X className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Plus className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                } else if (e.key === 'Tab' && !e.shiftKey && draft.trim() && !expanded) {
                  e.preventDefault();
                  setExpanded(true);
                }
              }}
              placeholder="Add a task — Enter to create, Tab for details"
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

          {expanded ? (
            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-200 pt-2 sm:grid-cols-3">
              <Field label="Due date">
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
                />
              </Field>
              <Field label="Assignee">
                <select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
                >
                  {teammates && teammates.length > 0 ? (
                    <>
                      <option value="">Unassigned</option>
                      {teammates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.displayName}
                        </option>
                      ))}
                    </>
                  ) : (
                    <option value={defaultAssignee}>Owner (default)</option>
                  )}
                </select>
              </Field>
              <Field label="Type">
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as TaskType | '')}
                  className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
                >
                  <option value="">—</option>
                  {(Object.keys(TYPE_LABEL) as TaskType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select
                  value={priority}
                  onChange={(e) =>
                    setPriority(e.target.value as Task['priority'])
                  }
                  className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
                >
                  {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
                    <option key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Repeat">
                <select
                  value={recurrence}
                  onChange={(e) =>
                    setRecurrence(
                      e.target.value as '' | 'daily' | 'weekly' | 'custom',
                    )
                  }
                  className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
                >
                  <option value="">No repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="custom">Custom (monthly)</option>
                </select>
              </Field>
              {entityType === 'deal' ? (
                <Field label="Blocks stage">
                  <select
                    value={stageBlocking}
                    onChange={(e) => setStageBlocking(e.target.value)}
                    className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
                  >
                    <option value="">None</option>
                    {DEAL_STAGE_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <div className="col-span-2 flex justify-end gap-2 sm:col-span-3">
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(false);
                    resetForm();
                  }}
                  className="rounded px-2 py-1 text-[12px] font-medium text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={pending || !draft.trim()}
                  className="rounded bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Create task
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {openTasks.length === 0 && completedTasks.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-[12px] text-slate-500">
          No tasks here yet. Type above to capture the next action.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <TaskGroup
            title="Overdue"
            tone="overdue"
            tasks={groups.overdue}
            canEdit={canEdit}
            today={today}
            onToggle={handleToggle}
          />
          <TaskGroup
            title="Today"
            tasks={groups.today}
            canEdit={canEdit}
            today={today}
            onToggle={handleToggle}
          />
          <TaskGroup
            title="Upcoming"
            tasks={groups.upcoming}
            canEdit={canEdit}
            today={today}
            onToggle={handleToggle}
          />
          <TaskGroup
            title="No due date"
            tasks={groups.nodue}
            canEdit={canEdit}
            today={today}
            onToggle={handleToggle}
          />

          {completedTasks.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setShowCompleted((v) => !v)}
                className="text-[11px] font-medium text-slate-500 hover:text-slate-700"
              >
                {showCompleted ? '▾' : '▸'} Done ({completedTasks.length})
              </button>
              {showCompleted ? (
                <ul className="mt-1 flex flex-col divide-y divide-slate-100">
                  {completedTasks.slice(0, 30).map((t) => (
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
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function TaskGroup({
  title,
  tone,
  tasks,
  canEdit,
  today,
  onToggle,
}: {
  title: string;
  tone?: 'overdue';
  tasks: TaskItem[];
  canEdit: boolean;
  today: Date;
  onToggle: (task: TaskItem, completed: boolean) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <div>
      <div
        className={cn(
          'mb-0.5 text-[10px] font-semibold uppercase tracking-wide',
          tone === 'overdue' ? 'text-rose-600' : 'text-slate-400',
        )}
      >
        {title}{' '}
        <span className="tabular-nums font-normal">({tasks.length})</span>
      </div>
      <ul className="flex flex-col divide-y divide-slate-100">
        {tasks.map((t) => (
          <TaskItemRow
            key={t.id}
            task={t}
            canEdit={canEdit}
            onToggle={() => onToggle(t, true)}
            today={today}
          />
        ))}
      </ul>
    </div>
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
  const TypeIcon = task.type ? TYPE_ICON[task.type] : null;

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
            'flex items-center gap-1 truncate text-[12.5px] text-slate-800',
            completed && 'text-slate-500 line-through decoration-slate-300',
          )}
        >
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
              PRIORITY_DOT[task.priority],
            )}
            title={`${TASK_PRIORITY_LABELS[task.priority]} priority`}
            aria-hidden
          />
          {TypeIcon ? (
            <TypeIcon
              className="h-3 w-3 shrink-0 text-slate-400"
              aria-label={task.type ? TYPE_LABEL[task.type] : undefined}
            />
          ) : null}
          <span className="truncate">{task.title}</span>
          {task.recurrence ? (
            <Repeat className="h-3 w-3 shrink-0 text-indigo-400" aria-label="Recurring" />
          ) : null}
        </p>
        {due || task.stageBlocking ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
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
            {task.stageBlocking ? (
              <span className="rounded bg-violet-100 px-1 py-0 font-medium text-violet-700">
                Blocks {task.stageBlocking}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {task.__pending && !isOptimistic ? (
        <Loader2
          className="mt-1 h-3 w-3 shrink-0 animate-spin text-slate-400"
          aria-hidden
        />
      ) : null}
    </li>
  );
}

function bucketOf(task: TaskItem, today: Date): Bucket {
  if (!task.dueDate) return 'nodue';
  const due = new Date(task.dueDate + 'T00:00:00');
  const diff = Math.round(
    (due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return 'upcoming';
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
  if (diff < 0) return { text: `${Math.abs(diff)}d overdue`, tone: 'overdue' };
  if (diff === 0) return { text: 'Due today', tone: 'soon' };
  if (diff === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (diff <= 7) return { text: `Due in ${diff}d`, tone: 'soon' };
  return {
    text: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    tone: 'normal',
  };
}
