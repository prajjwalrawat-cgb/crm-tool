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
import { recordNotification } from '@/lib/notifications/recorder';

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

        // Notify the assignee when the task is assigned to someone
        // other than the creator. The recorder skips self-targets and
        // dedupes empty ids, so we can write the call unconditionally.
        if (row.assignedUserId && row.assignedUserId !== membership.userId) {
          await recordNotification(tx, {
            tenantId: tenant.id,
            recipientUserId: row.assignedUserId,
            actorUserId: membership.userId,
            type: 'task_assigned',
            title: `New task: ${row.title}`,
            subtitle: row.dueDate ? `Due ${row.dueDate}` : null,
            entityType: 'task',
            entityId: row.id,
            metadata: {
              priority: row.priority,
              linkedEntityType: row.entityType,
              linkedEntityId: row.entityId,
            },
          });
        }

        return row;
      });

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

        // Reassignment notification: notify the new assignee if it's
        // a real change and not back to the actor themselves.
        const reassigned =
          (previous.assignedUserId ?? null) !== (row.assignedUserId ?? null);
        if (
          reassigned &&
          row.assignedUserId &&
          row.assignedUserId !== membership.userId
        ) {
          await recordNotification(tx, {
            tenantId: tenant.id,
            recipientUserId: row.assignedUserId,
            actorUserId: membership.userId,
            type: 'task_assigned',
            title: `Reassigned to you: ${row.title}`,
            subtitle: row.dueDate ? `Due ${row.dueDate}` : null,
            entityType: 'task',
            entityId: row.id,
            metadata: { reassign: true },
          });
        }

        // Completion notification to the creator when someone else
        // closes out their task.
        if (
          justCompleted &&
          previous.createdBy &&
          previous.createdBy !== membership.userId
        ) {
          await recordNotification(tx, {
            tenantId: tenant.id,
            recipientUserId: previous.createdBy,
            actorUserId: membership.userId,
            type: 'task_completed',
            title: `Task completed: ${row.title}`,
            subtitle: null,
            entityType: 'task',
            entityId: row.id,
            metadata: {},
          });
        }

        return row;
      });

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true, task: updated };
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

        if (
          (completed && previous.status === 'completed') ||
          (!completed && previous.status !== 'completed')
        ) {
          return previous; // no-op
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

        if (
          completed &&
          previous.createdBy &&
          previous.createdBy !== membership.userId
        ) {
          await recordNotification(tx, {
            tenantId: tenant.id,
            recipientUserId: previous.createdBy,
            actorUserId: membership.userId,
            type: 'task_completed',
            title: `Task completed: ${row.title}`,
            subtitle: null,
            entityType: 'task',
            entityId: row.id,
            metadata: {},
          });
        }

        return row;
      });

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true, task: updated };
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
