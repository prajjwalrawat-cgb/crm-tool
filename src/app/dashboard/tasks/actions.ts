'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { tasks, type Task } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { recordNotificationSafe } from '@/lib/notifications/recorder';

const TASK_STATUSES = ['todo', 'in_progress', 'completed', 'cancelled'] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const TASK_ENTITY_TYPES = ['deal', 'company', 'contact'] as const;

/**
 * Tasks reuse the existing `manageDeals` permission for now — operational
 * tasks are part of the same workflow as deal management. Splitting tasks
 * onto their own permission grain would be a follow-up if RBAC matrices
 * actually diverge.
 */
const TASK_PERMISSION = 'manageDeals' as const;

const createTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(280),
  description: z.string().max(4000).optional().nullable(),
  status: z.enum(TASK_STATUSES).default('todo'),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .nullable(),
  assignedUserId: z.string().max(120).optional().nullable(),
  entityType: z.enum(TASK_ENTITY_TYPES).optional().nullable(),
  entityId: z.uuid().optional().nullable(),
});

const updateTaskSchema = createTaskSchema.extend({
  id: z.uuid(),
});

const taskIdSchema = z.object({ id: z.uuid() });

export type TaskActionResult =
  | { ok: true; task: Task }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export type SimpleTaskResult =
  | { ok: true }
  | { ok: false; message: string };

function parseFormData(
  formData: FormData,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of [
    'id',
    'title',
    'description',
    'status',
    'priority',
    'dueDate',
    'assignedUserId',
    'entityType',
    'entityId',
  ]) {
    const v = formData.get(key);
    out[key] = typeof v === 'string' ? (v.trim() === '' ? null : v) : null;
  }
  return out;
}

export async function createTaskAction(
  formData: FormData,
): Promise<TaskActionResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const raw = parseFormData(formData);
      const parsed = createTaskSchema.safeParse(raw);
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        return {
          ok: false,
          message: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
          fieldErrors: flat.fieldErrors as Record<string, string[]>,
        };
      }

      const inserted = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(tasks)
          .values({
            tenantId: tenant.id,
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            status: parsed.data.status,
            priority: parsed.data.priority,
            dueDate: parsed.data.dueDate ?? null,
            assignedUserId: parsed.data.assignedUserId ?? null,
            createdBy: membership.userId,
            entityType: parsed.data.entityType ?? null,
            entityId: parsed.data.entityId ?? null,
          })
          .returning();
        if (!row) throw new Error('Failed to insert task');

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'task',
          entityId: row.id,
          action: 'created',
          metadata: {
            taskTitle: row.title,
            taskPriority: row.priority,
            dueDate: row.dueDate,
            linkedEntityType: row.entityType,
            linkedEntityId: row.entityId,
          },
        });

        return row;
      });

      // Post-commit best-effort notification. A failure here (RLS edge,
      // realtime payload error, etc.) must not crash the create.
      if (
        inserted.assignedUserId &&
        inserted.assignedUserId !== membership.userId
      ) {
        await recordNotificationSafe({
          tenantId: tenant.id,
          recipientUserId: inserted.assignedUserId,
          actorUserId: membership.userId,
          type: 'task_assigned',
          title: `New task: ${inserted.title}`,
          subtitle: inserted.dueDate ? `Due ${inserted.dueDate}` : null,
          entityType: 'task',
          entityId: inserted.id,
          metadata: {
            priority: inserted.priority,
            linkedEntityType: inserted.entityType,
            linkedEntityId: inserted.entityId,
          },
        });
      }

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true, task: inserted };
    },
  );
}

export async function updateTaskAction(
  formData: FormData,
): Promise<TaskActionResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const raw = parseFormData(formData);
      const parsed = updateTaskSchema.safeParse(raw);
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        return {
          ok: false,
          message: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
          fieldErrors: flat.fieldErrors as Record<string, string[]>,
        };
      }

      const updated = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.id, parsed.data.id),
              eq(tasks.tenantId, tenant.id),
              isNull(tasks.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) throw new Error('Task not found');

        const justCompleted =
          parsed.data.status === 'completed' && previous.status !== 'completed';

        const [row] = await tx
          .update(tasks)
          .set({
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            status: parsed.data.status,
            priority: parsed.data.priority,
            dueDate: parsed.data.dueDate ?? null,
            assignedUserId: parsed.data.assignedUserId ?? null,
            entityType: parsed.data.entityType ?? null,
            entityId: parsed.data.entityId ?? null,
            completedAt: justCompleted ? new Date() : previous.completedAt,
          })
          .where(eq(tasks.id, parsed.data.id))
          .returning();
        if (!row) throw new Error('Update failed');

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'task',
          entityId: row.id,
          action: justCompleted ? 'task_completed' : 'updated',
          metadata: {
            taskTitle: row.title,
            previousStatus: previous.status,
            status: row.status,
            linkedEntityType: row.entityType,
            linkedEntityId: row.entityId,
          },
        });

        return {
          row,
          previousAssignee: previous.assignedUserId ?? null,
          previousCreator: previous.createdBy,
          justCompleted,
        };
      });

      // Post-commit, best-effort notification fan-out.
      const reassigned =
        updated.previousAssignee !== (updated.row.assignedUserId ?? null);
      if (
        reassigned &&
        updated.row.assignedUserId &&
        updated.row.assignedUserId !== membership.userId
      ) {
        await recordNotificationSafe({
          tenantId: tenant.id,
          recipientUserId: updated.row.assignedUserId,
          actorUserId: membership.userId,
          type: 'task_assigned',
          title: `Reassigned to you: ${updated.row.title}`,
          subtitle: updated.row.dueDate ? `Due ${updated.row.dueDate}` : null,
          entityType: 'task',
          entityId: updated.row.id,
          metadata: { reassign: true },
        });
      }
      if (
        updated.justCompleted &&
        updated.previousCreator &&
        updated.previousCreator !== membership.userId
      ) {
        await recordNotificationSafe({
          tenantId: tenant.id,
          recipientUserId: updated.previousCreator,
          actorUserId: membership.userId,
          type: 'task_completed',
          title: `Task completed: ${updated.row.title}`,
          subtitle: null,
          entityType: 'task',
          entityId: updated.row.id,
          metadata: {},
        });
      }

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true, task: updated.row };
    },
  );
}

const toggleSchema = z.object({
  id: z.uuid(),
  completed: z.union([z.boolean(), z.literal('true'), z.literal('false')]),
});

/**
 * Optimistic completion-toggle handler used by the inline checkbox on
 * task rows. Single-purpose so the client doesn't need to ship the
 * full update form payload.
 */
export async function toggleTaskCompletedAction(
  input: { id: string; completed: boolean },
): Promise<TaskActionResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const parsed = toggleSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: 'Invalid toggle payload' };
      }
      const completed =
        parsed.data.completed === true ||
        parsed.data.completed === 'true';

      // Critical path: update task + record activity atomically. Notifications
      // are written AFTER this transaction commits so a notification crash
      // (RLS edge, NOTIFY payload, transient publish error) can never roll
      // back the task status change. See recordNotificationSafe.
      const result = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.id, parsed.data.id),
              eq(tasks.tenantId, tenant.id),
              isNull(tasks.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) throw new Error('Task not found');

        if (
          (completed && previous.status === 'completed') ||
          (!completed && previous.status !== 'completed')
        ) {
          return { row: previous, changed: false };
        }

        const [row] = await tx
          .update(tasks)
          .set({
            status: completed ? 'completed' : 'todo',
            completedAt: completed ? new Date() : null,
          })
          .where(eq(tasks.id, parsed.data.id))
          .returning();
        if (!row) throw new Error('Toggle failed');

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'task',
          entityId: row.id,
          action: completed ? 'task_completed' : 'updated',
          metadata: {
            taskTitle: row.title,
            previousStatus: previous.status,
            status: row.status,
            linkedEntityType: row.entityType,
            linkedEntityId: row.entityId,
          },
        });

        return {
          row,
          changed: true,
          notifyCreator:
            completed &&
            previous.createdBy &&
            previous.createdBy !== membership.userId
              ? previous.createdBy
              : null,
        };
      });

      // Best-effort notification fan-out. Never bubbles up to the action
      // boundary; logged + captured if it fails.
      if (result.changed && 'notifyCreator' in result && result.notifyCreator) {
        await recordNotificationSafe({
          tenantId: tenant.id,
          recipientUserId: result.notifyCreator,
          actorUserId: membership.userId,
          type: 'task_completed',
          title: `Task completed: ${result.row.title}`,
          subtitle: null,
          entityType: 'task',
          entityId: result.row.id,
          metadata: {},
        });
      }

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true, task: result.row };
    },
  );
}

/**
 * Partial-field updater for inline edits (priority cycler, status
 * dropdown, assignee swap). Skips the heavy update form payload — the
 * caller passes only what changed. Reassignment routes through
 * `recordNotification` so the new assignee gets pinged the same way
 * the full-form update does.
 */
const inlineUpdateSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1, 'Title is required').max(280).optional(),
  description: z.string().max(4000).nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignedUserId: z.string().max(120).nullable().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .nullable()
    .optional(),
});

export async function updateTaskFieldsAction(input: {
  id: string;
  title?: string;
  description?: string | null;
  priority?: (typeof TASK_PRIORITIES)[number];
  status?: (typeof TASK_STATUSES)[number];
  assignedUserId?: string | null;
  dueDate?: string | null;
}): Promise<TaskActionResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const parsed = inlineUpdateSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: 'Invalid update payload' };
      }

      const patch: Record<string, unknown> = {};
      if (parsed.data.title !== undefined) patch.title = parsed.data.title;
      if (parsed.data.description !== undefined) {
        patch.description = parsed.data.description;
      }
      if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
      if (parsed.data.status !== undefined) {
        patch.status = parsed.data.status;
        // Mirror toggleTaskCompletedAction: stamp completedAt when entering
        // the completed terminal state so the dashboard widgets stay
        // honest about completion time.
        if (parsed.data.status === 'completed') {
          patch.completedAt = new Date();
        } else {
          patch.completedAt = null;
        }
      }
      if (parsed.data.assignedUserId !== undefined) {
        patch.assignedUserId = parsed.data.assignedUserId;
      }
      if (parsed.data.dueDate !== undefined) patch.dueDate = parsed.data.dueDate;

      if (Object.keys(patch).length === 0) {
        return { ok: false, message: 'Nothing to update' };
      }

      const updated = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.id, parsed.data.id),
              eq(tasks.tenantId, tenant.id),
              isNull(tasks.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) return null;

        const [row] = await tx
          .update(tasks)
          .set(patch)
          .where(
            and(
              eq(tasks.id, parsed.data.id),
              eq(tasks.tenantId, tenant.id),
              isNull(tasks.deletedAt),
            ),
          )
          .returning();
        if (!row) return null;

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'task',
          entityId: row.id,
          action: 'updated',
          metadata: {
            taskTitle: row.title,
            fields: Object.keys(patch),
            ...(parsed.data.priority !== undefined
              ? { priority: { from: previous.priority, to: row.priority } }
              : {}),
            ...(parsed.data.status !== undefined
              ? { status: { from: previous.status, to: row.status } }
              : {}),
            ...(parsed.data.assignedUserId !== undefined
              ? {
                  assignedTo: {
                    from: previous.assignedUserId ?? null,
                    to: row.assignedUserId ?? null,
                  },
                }
              : {}),
          },
        });

        return {
          row,
          reassigned:
            parsed.data.assignedUserId !== undefined &&
            (previous.assignedUserId ?? null) !== (row.assignedUserId ?? null),
        };
      });

      if (!updated) return { ok: false, message: 'Task not found' };

      // Post-commit, best-effort reassignment notification.
      if (
        updated.reassigned &&
        updated.row.assignedUserId &&
        updated.row.assignedUserId !== membership.userId
      ) {
        await recordNotificationSafe({
          tenantId: tenant.id,
          recipientUserId: updated.row.assignedUserId,
          actorUserId: membership.userId,
          type: 'task_assigned',
          title: `Task assigned: ${updated.row.title}`,
          entityType: 'task',
          entityId: updated.row.id,
          metadata: { taskTitle: updated.row.title },
        });
      }

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true, task: updated.row };
    },
  );
}

export async function softDeleteTaskAction(
  id: string,
): Promise<SimpleTaskResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const parsed = taskIdSchema.safeParse({ id });
      if (!parsed.success) return { ok: false, message: 'Invalid id' };

      await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(tasks)
          .set({ deletedAt: new Date(), deletedBy: membership.userId })
          .where(
            and(
              eq(tasks.id, parsed.data.id),
              eq(tasks.tenantId, tenant.id),
              isNull(tasks.deletedAt),
            ),
          )
          .returning();
        if (!row) return;
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'task',
          entityId: row.id,
          action: 'deleted',
          metadata: { taskTitle: row.title },
        });
      });

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true };
    },
  );
}
