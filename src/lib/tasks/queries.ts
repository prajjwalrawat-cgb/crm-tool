import 'server-only';

import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';

import {
  companies,
  contacts,
  deals,
  tasks,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import {
  buildPage,
  type Cursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PageSize,
} from '@/lib/pagination/cursor';
import { timeQuery } from '@/lib/pagination/timing';
import type { TaskFilters } from '@/lib/tasks/filters';

export type { TaskFilters } from '@/lib/tasks/filters';

/**
 * A task plus the linked entity's display name. The detail page needs
 * this so a row can say "Razorpay — Q2 renewal kickoff" without a
 * second round-trip per row.
 */
export type TaskRow = Task & {
  linkedName: string | null;
};

export type ListTasksOptions = {
  search?: string;
  cursor?: Cursor | null;
  size?: PageSize;
  filters?: TaskFilters;
  /** Required when `filters.assignedToMe` is set. */
  currentUserId?: string;
  /**
   * Hard-restrict to tasks assigned to this user OR unassigned. Used
   * by sales-persona pages to enforce member visibility at SSR.
   */
  restrictToAssigneeOrUnassigned?: string;
};

/**
 * Paginated task listing. Sort order is intentionally a stable
 * (due_date asc nulls last, created_at desc, id desc) tuple — the
 * cursor uses created_at + id since due_date is mutable.
 */
export async function listTasks(
  tenantId: string,
  options: ListTasksOptions = {},
): Promise<Page<TaskRow>> {
  const term = options.search?.trim();
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  const f = options.filters ?? {};

  const conditions: SQL[] = [
    eq(tasks.tenantId, tenantId),
    isNull(tasks.deletedAt),
  ];

  if (term) {
    conditions.push(sql`${tasks.title} ILIKE ${'%' + term + '%'}`);
  }
  if (f.statuses && f.statuses.length > 0) {
    conditions.push(inArray(tasks.status, f.statuses));
  }
  if (f.priorities && f.priorities.length > 0) {
    conditions.push(inArray(tasks.priority, f.priorities));
  }
  if (f.assignedToMe && options.currentUserId) {
    conditions.push(eq(tasks.assignedUserId, options.currentUserId));
  }
  if (f.unassigned) {
    conditions.push(isNull(tasks.assignedUserId));
  }
  if (options.restrictToAssigneeOrUnassigned) {
    const me = options.restrictToAssigneeOrUnassigned;
    conditions.push(
      sql`(${tasks.assignedUserId} = ${me} OR ${tasks.assignedUserId} IS NULL)`,
    );
  }
  if (typeof f.dueWithinDays === 'number') {
    conditions.push(
      sql`${tasks.dueDate} IS NOT NULL`,
      sql`${tasks.dueDate} <= CURRENT_DATE + (${f.dueWithinDays}::int * INTERVAL '1 day')`,
    );
  }
  if (f.overdue) {
    conditions.push(
      sql`${tasks.dueDate} IS NOT NULL`,
      sql`${tasks.dueDate} < CURRENT_DATE`,
      sql`${tasks.status} NOT IN ('completed','cancelled')`,
    );
  }
  if (options.cursor) {
    conditions.push(
      sql`(${tasks.createdAt}, ${tasks.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
    );
  }

  return await timeQuery('tasks.list', async () => {
    const rows = await tenantTransaction(async (tx) =>
      tx
        .select({
          id: tasks.id,
          tenantId: tasks.tenantId,
          title: tasks.title,
          description: tasks.description,
          status: tasks.status,
          priority: tasks.priority,
          dueDate: tasks.dueDate,
          assignedUserId: tasks.assignedUserId,
          createdBy: tasks.createdBy,
          completedAt: tasks.completedAt,
          entityType: tasks.entityType,
          entityId: tasks.entityId,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
          deletedAt: tasks.deletedAt,
          deletedBy: tasks.deletedBy,
          // Resolve the linked entity's display name via three left joins.
          // Only one of these will be non-null per row.
          dealName: deals.name,
          companyName: companies.name,
          contactFirstName: contacts.firstName,
          contactLastName: contacts.lastName,
          contactEmail: contacts.email,
        })
        .from(tasks)
        .leftJoin(
          deals,
          and(
            eq(tasks.entityType, 'deal'),
            eq(tasks.entityId, deals.id),
          ),
        )
        .leftJoin(
          companies,
          and(
            eq(tasks.entityType, 'company'),
            eq(tasks.entityId, companies.id),
          ),
        )
        .leftJoin(
          contacts,
          and(
            eq(tasks.entityType, 'contact'),
            eq(tasks.entityId, contacts.id),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(size + 1),
    );

    const shaped: TaskRow[] = rows.map((r) => {
      let linkedName: string | null = null;
      if (r.entityType === 'deal') {
        linkedName = r.dealName;
      } else if (r.entityType === 'company') {
        linkedName = r.companyName;
      } else if (r.entityType === 'contact') {
        const parts = [r.contactFirstName, r.contactLastName].filter(
          Boolean,
        ) as string[];
        linkedName = parts.length > 0 ? parts.join(' ') : r.contactEmail;
      }
      return {
        id: r.id,
        tenantId: r.tenantId,
        title: r.title,
        description: r.description,
        status: r.status,
        priority: r.priority,
        dueDate: r.dueDate,
        assignedUserId: r.assignedUserId,
        createdBy: r.createdBy,
        completedAt: r.completedAt,
        entityType: r.entityType,
        entityId: r.entityId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        deletedAt: r.deletedAt,
        deletedBy: r.deletedBy,
        linkedName,
      };
    });

    return buildPage(shaped, size, (r) => ({
      ts: r.createdAt.toISOString(),
      id: r.id,
    }));
  });
}

/**
 * Tasks linked to a specific entity (used by deal/company/contact
 * detail pages). Capped to a sensible per-page limit; we don't bother
 * paginating per-entity unless someone reports needing more than ~50.
 */
export async function listTasksForEntity(
  tenantId: string,
  entityType: 'deal' | 'company' | 'contact',
  entityId: string,
  options: { limit?: number } = {},
): Promise<Task[]> {
  const limit = options.limit ?? 50;
  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.entityType, entityType),
          eq(tasks.entityId, entityId),
          isNull(tasks.deletedAt),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(limit),
  );
}

/**
 * Compact "my tasks" rollup for the dashboard widget. Returns the
 * counts plus the next ~5 actionable items for the signed-in user.
 */
export type MyTasksSummary = {
  openCount: number;
  overdueCount: number;
  completedThisWeek: number;
  upcoming: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate: string | null;
    isOverdue: boolean;
  }>;
};

export async function getMyTasksSummary(
  tenantId: string,
  userId: string,
): Promise<MyTasksSummary> {
  return await timeQuery('tasks.mySummary', async () =>
    tenantTransaction(async (tx) => {
      const counts = (await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::int AS open_count,
          COUNT(*) FILTER (
            WHERE status NOT IN ('completed','cancelled')
              AND due_date IS NOT NULL
              AND due_date < CURRENT_DATE
          )::int AS overdue_count,
          COUNT(*) FILTER (
            WHERE status = 'completed'
              AND completed_at >= NOW() - INTERVAL '7 days'
          )::int AS completed_week
        FROM tasks
        WHERE tenant_id = ${tenantId}::uuid
          AND assigned_user_id = ${userId}
          AND deleted_at IS NULL
      `)) as unknown as Array<{
        open_count: number;
        overdue_count: number;
        completed_week: number;
      }>;
      const c = counts[0] ?? {
        open_count: 0,
        overdue_count: 0,
        completed_week: 0,
      };

      const upcomingRows = (await tx.execute(sql`
        SELECT id, title, status::text AS status, priority::text AS priority,
               due_date::text AS due_date,
               (due_date IS NOT NULL AND due_date < CURRENT_DATE) AS is_overdue
        FROM tasks
        WHERE tenant_id = ${tenantId}::uuid
          AND assigned_user_id = ${userId}
          AND deleted_at IS NULL
          AND status NOT IN ('completed','cancelled')
        ORDER BY
          (due_date IS NULL) ASC,
          due_date ASC,
          CASE priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
          END
        LIMIT 5
      `)) as unknown as Array<{
        id: string;
        title: string;
        status: TaskStatus;
        priority: TaskPriority;
        due_date: string | null;
        is_overdue: boolean;
      }>;

      return {
        openCount: c.open_count,
        overdueCount: c.overdue_count,
        completedThisWeek: c.completed_week,
        upcoming: upcomingRows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          dueDate: r.due_date,
          isOverdue: r.is_overdue,
        })),
      };
    }),
  );
}

export async function getTaskById(
  tenantId: string,
  id: string,
): Promise<Task | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, id),
          eq(tasks.tenantId, tenantId),
          isNull(tasks.deletedAt),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}
