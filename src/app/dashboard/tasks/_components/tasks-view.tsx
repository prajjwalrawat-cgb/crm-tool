'use client';

import { Loader2, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';
import { toast } from 'sonner';

import type { MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactOption } from '@/lib/contacts/queries';
import type { DealOption } from '@/lib/deals/queries';
import type { PageSize } from '@/lib/pagination/page-size';
import { canManageDeals } from '@/lib/rbac';
import type { TaskFilters } from '@/lib/tasks/filters';
import type { TaskRow } from '@/lib/tasks/queries';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { CreateDrawer } from '../../_components/create-drawer';
import { PaginationControls } from '../../_components/pagination-controls';
import { ToggleFilterBar } from '../../_components/toggle-filter-bar';
import {
  createTaskAction,
  softDeleteTaskAction,
  toggleTaskCompletedAction,
} from '../actions';
import { CreateTaskForm } from './create-task-form';
import { TaskDetailDrawer } from './task-detail-drawer';
import { TaskRowItem } from './task-row';

type TaskItem = TaskRow & { __pending?: boolean };

type OptimisticOp =
  | { type: 'create'; draft: TaskItem }
  | { type: 'toggle'; id: string; completed: boolean }
  | { type: 'remove'; id: string };

export function TasksView({
  initialItems,
  initialSearch,
  initialFilters,
  currentUserId,
  currentRole,
  companyOptions,
  contactOptions,
  dealOptions,
  teammates,
  nextCursor,
  pageSize,
}: {
  initialItems: TaskRow[];
  initialSearch: string;
  initialFilters: TaskFilters;
  currentUserId: string;
  currentRole: MembershipRole;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  dealOptions: DealOption[];
  teammates: Teammate[];
  nextCursor: string | null;
  pageSize: PageSize;
}) {
  const router = useRouter();
  const canEdit = canManageDeals(currentRole);

  const [search, setSearch] = useState(initialSearch);
  const [searchPending, startSearchTransition] = useTransition();
  const [createPending, startCreateTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<
    Record<string, string[]>
  >({});
  const [createResetKey, setCreateResetKey] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const [optimisticItems, applyOptimistic] = useOptimistic<TaskItem[], OptimisticOp>(
    initialItems,
    (state, op) => {
      switch (op.type) {
        case 'create':
          return [op.draft, ...state];
        case 'toggle':
          return state.map((t) =>
            t.id === op.id
              ? {
                  ...t,
                  status: op.completed ? 'completed' : 'todo',
                  completedAt: op.completed ? new Date() : null,
                  __pending: true,
                }
              : t,
          );
        case 'remove':
          return state.filter((t) => t.id !== op.id);
      }
    },
  );

  const isFirstSearchRender = useRef(true);
  useEffect(() => {
    if (isFirstSearchRender.current) {
      isFirstSearchRender.current = false;
      return;
    }
    const handle = setTimeout(() => {
      startSearchTransition(() => {
        const params = new URLSearchParams();
        const trimmed = search.trim();
        if (trimmed) params.set('q', trimmed);
        if (pageSize !== 50) params.set('size', String(pageSize));
        const qs = params.toString();
        router.replace(`/dashboard/tasks${qs ? `?${qs}` : ''}`);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [search, router, pageSize]);

  const handleCreate = useCallback(
    (formData: FormData) => {
      setCreateError(null);
      setCreateFieldErrors({});
      const title = String(formData.get('title') ?? '(untitled)');
      const draft: TaskItem = {
        id: `optimistic-${crypto.randomUUID()}`,
        tenantId: '',
        title,
        description: (formData.get('description') as string) || null,
        status: (formData.get('status') as TaskItem['status']) ?? 'todo',
        priority: (formData.get('priority') as TaskItem['priority']) ?? 'medium',
        dueDate: (formData.get('dueDate') as string) || null,
        assignedUserId: (formData.get('assignedUserId') as string) || null,
        createdBy: currentUserId,
        completedAt: null,
        entityType: (formData.get('entityType') as 'deal' | 'company' | 'contact' | null) || null,
        entityId: (formData.get('entityId') as string) || null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        deletedBy: null,
        linkedName: null,
        __pending: true,
      };
      startCreateTransition(async () => {
        applyOptimistic({ type: 'create', draft });
        const result = await createTaskAction(formData);
        if (!result.ok) {
          setCreateError(result.message);
          setCreateFieldErrors(result.fieldErrors ?? {});
          toast.error(result.message);
        } else {
          setCreateResetKey((k) => k + 1);
          toast.success(`Task created — ${result.task.title}`);
        }
      });
    },
    [applyOptimistic, currentUserId],
  );

  const handleToggle = useCallback(
    (task: TaskItem, completed: boolean) => {
      startCreateTransition(async () => {
        applyOptimistic({ type: 'toggle', id: task.id, completed });
        const result = await toggleTaskCompletedAction({
          id: task.id,
          completed,
        });
        if (!result.ok) toast.error(result.message);
      });
    },
    [applyOptimistic],
  );

  const handleDelete = useCallback(
    (task: TaskItem) => {
      setActionError(null);
      startCreateTransition(async () => {
        applyOptimistic({ type: 'remove', id: task.id });
        const result = await softDeleteTaskAction(task.id);
        if (!result.ok) {
          setActionError(result.message);
          toast.error(result.message);
        } else {
          toast.success('Task deleted');
        }
      });
    },
    [applyOptimistic],
  );

  const showEmpty = optimisticItems.length === 0;
  const trimmedSearch = search.trim();

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks by title…"
              aria-label="Search tasks"
              className={cn(
                'w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-sm shadow-sm transition',
                'placeholder:text-slate-400',
                'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20',
              )}
            />
            {searchPending ? (
              <Loader2
                className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400"
                aria-hidden
              />
            ) : null}
          </div>
          {canEdit ? (
            <CreateDrawer
              label="New task"
              drawerTitle="Create task"
              description="Add an action item — optionally link it to a deal, company, or contact."
              closeOnSuccessKey={createResetKey}
            >
              {() => (
                <CreateTaskForm
                  onSubmit={handleCreate}
                  pending={createPending}
                  error={createError}
                  fieldErrors={createFieldErrors}
                  resetKey={createResetKey}
                  companyOptions={companyOptions}
                  contactOptions={contactOptions}
                  dealOptions={dealOptions}
                  currentUserId={currentUserId}
                  teammates={teammates}
                />
              )}
            </CreateDrawer>
          ) : null}
        </div>

        <ToggleFilterBar
          basePath="/dashboard/tasks"
          toggles={[
            { key: 'assignedToMe', label: 'My tasks', title: 'Tasks assigned to me' },
            { key: 'overdue', label: 'Overdue', title: 'Past-due, not completed' },
            { key: 'dueWithinDays', value: '7', label: 'Due this week' },
            { key: 'status', value: 'todo', label: 'To do' },
            { key: 'status', value: 'in_progress', label: 'In progress' },
            { key: 'priority', value: 'urgent,high', label: 'High / urgent' },
            { key: 'unassigned', label: 'Unassigned' },
          ]}
        />

        {actionError ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {actionError}
          </p>
        ) : null}

        {showEmpty ? (
          <EmptyState searchActive={trimmedSearch.length > 0} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <ul className="divide-y divide-slate-100">
              {optimisticItems.map((t) => (
                <TaskRowItem
                  key={t.id}
                  task={t}
                  canEdit={canEdit}
                  onToggle={(completed) => handleToggle(t, completed)}
                  onDelete={() => handleDelete(t)}
                  onOpen={() => setSelectedTaskId(t.id)}
                />
              ))}
            </ul>
            <PaginationControls
              basePath="/dashboard/tasks"
              nextCursor={nextCursor}
              size={pageSize}
              visibleCount={optimisticItems.length}
            />
          </div>
        )}
      </section>

      <TaskDetailDrawer
        task={
          selectedTaskId
            ? optimisticItems.find((t) => t.id === selectedTaskId) ?? null
            : null
        }
        teammates={teammates}
        currentUserId={currentUserId}
        onClose={() => setSelectedTaskId(null)}
      />
    </div>
  );
}

function EmptyState({ searchActive }: { searchActive: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
      <Trash2
        className="mx-auto h-6 w-6 text-slate-300"
        aria-hidden
        style={{ transform: 'rotate(0deg)' }}
      />
      <h3 className="mt-2 text-sm font-semibold text-slate-700">
        {searchActive ? 'No tasks match your search' : 'No tasks yet'}
      </h3>
      <p className="mt-1 text-[12px] text-slate-500">
        {searchActive
          ? 'Try a different title or clear the filter chips.'
          : 'Use "New task" to capture an action item — optionally link it to a deal.'}
      </p>
    </div>
  );
}
