import type { TaskPriority, TaskStatus } from '@/db/schema';

/**
 * Client- and server-safe filter helpers for tasks.
 *
 * URL contract:
 *   status=todo,in_progress     comma list (multi-select)
 *   priority=high,urgent        comma list
 *   assignedToMe=1              filter to current user's assignments
 *   unassigned=1                only unassigned tasks
 *   dueWithinDays=7             due in the next N days (incl. overdue)
 *   overdue=1                   only past-due, non-completed
 */

const TASK_STATUSES_LIST: TaskStatus[] = [
  'todo',
  'in_progress',
  'completed',
  'cancelled',
];
const TASK_PRIORITIES_LIST: TaskPriority[] = [
  'low',
  'medium',
  'high',
  'urgent',
];

export type TaskFilters = {
  statuses?: TaskStatus[];
  priorities?: TaskPriority[];
  assignedToMe?: boolean;
  unassigned?: boolean;
  dueWithinDays?: number;
  overdue?: boolean;
};

const flag = (v: string | string[] | undefined): boolean =>
  v === '1' || v === 'true';
const num = (
  v: string | string[] | undefined,
): number | undefined => {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const csList = <T extends string>(
  v: string | string[] | undefined,
  allowed: readonly T[],
): T[] => {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : v.split(',');
  return arr
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
};

export function parseTaskFilters(
  raw: Partial<Record<string, string | string[] | undefined>>,
): TaskFilters {
  const statuses = csList(raw.status, TASK_STATUSES_LIST);
  const priorities = csList(raw.priority, TASK_PRIORITIES_LIST);
  return {
    statuses: statuses.length > 0 ? statuses : undefined,
    priorities: priorities.length > 0 ? priorities : undefined,
    assignedToMe: flag(raw.assignedToMe),
    unassigned: flag(raw.unassigned),
    dueWithinDays: num(raw.dueWithinDays),
    overdue: flag(raw.overdue),
  };
}

export function taskFiltersToSearchParams(
  filters: TaskFilters,
): URLSearchParams {
  const out = new URLSearchParams();
  if (filters.statuses && filters.statuses.length > 0) {
    out.set('status', filters.statuses.join(','));
  }
  if (filters.priorities && filters.priorities.length > 0) {
    out.set('priority', filters.priorities.join(','));
  }
  if (filters.assignedToMe) out.set('assignedToMe', '1');
  if (filters.unassigned) out.set('unassigned', '1');
  if (filters.dueWithinDays)
    out.set('dueWithinDays', String(filters.dueWithinDays));
  if (filters.overdue) out.set('overdue', '1');
  return out;
}

export function hasActiveTaskFilters(filters: TaskFilters): boolean {
  return Boolean(
    (filters.statuses && filters.statuses.length > 0) ||
      (filters.priorities && filters.priorities.length > 0) ||
      filters.assignedToMe ||
      filters.unassigned ||
      filters.dueWithinDays ||
      filters.overdue,
  );
}

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
