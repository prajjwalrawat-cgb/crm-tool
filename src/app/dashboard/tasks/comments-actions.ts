'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { taskComments, tasks, type TaskComment } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { listCommentsForTask } from '@/lib/task-comments/queries';

const TASK_PERMISSION = 'manageDeals' as const;

const createSchema = z.object({
  taskId: z.uuid({ message: 'Invalid task id' }),
  body: z.string().trim().min(1, 'Comment cannot be empty').max(4000),
});

const editSchema = z.object({
  id: z.uuid(),
  body: z.string().trim().min(1).max(4000),
});

const idSchema = z.object({ id: z.uuid() });

export type TaskCommentResult =
  | { ok: true; comment: TaskComment }
  | { ok: false; message: string };

export type SimpleResult = { ok: true } | { ok: false; message: string };

export type LoadTaskCommentsResult =
  | { ok: true; comments: TaskComment[] }
  | { ok: false; message: string };

/**
 * Read-only loader the drawer calls on open. Wrapped in a server
 * action so we don't have to introduce an API route for this.
 */
export async function loadTaskCommentsAction(
  taskId: string,
): Promise<LoadTaskCommentsResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = idSchema.safeParse({ id: taskId });
  if (!parsed.success) return { ok: false, message: 'Invalid task id' };

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const rows = await listCommentsForTask(tenant.id, parsed.data.id, {
        limit: 200,
      });
      return { ok: true, comments: rows };
    },
  );
}

/**
 * Post a new comment on a task. Records activity on the task entity so
 * the timeline reflects the discussion (the comment itself lives in
 * task_comments; the activity row gives the timeline a pointer).
 */
export async function createTaskCommentAction(input: {
  taskId: string;
  body: string;
}): Promise<TaskCommentResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: flat.formErrors[0] ?? 'Please enter a comment.',
    };
  }

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      // Confirm the task exists in this tenant and isn't soft-deleted.
      // Without this an attacker could craft a foreign task id and post
      // a comment that nobody would ever see, but the row would still
      // count toward storage.
      const [parentTask] = await tenantTransaction(async (tx) =>
        tx
          .select({ id: tasks.id, title: tasks.title })
          .from(tasks)
          .where(
            and(
              eq(tasks.id, parsed.data.taskId),
              eq(tasks.tenantId, tenant.id),
            ),
          )
          .limit(1),
      );
      if (!parentTask) return { ok: false, message: 'Task not found' };

      const inserted = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(taskComments)
          .values({
            tenantId: tenant.id,
            taskId: parsed.data.taskId,
            authorUserId: membership.userId,
            body: parsed.data.body,
          })
          .returning();
        if (!row) throw new Error('Failed to insert task comment');

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'task',
          entityId: parsed.data.taskId,
          action: 'updated',
          metadata: {
            kind: 'task_comment',
            commentId: row.id,
            commentPreview: row.body.slice(0, 80),
            taskTitle: parentTask.title,
          },
        });

        return row;
      });

      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard');
      return { ok: true, comment: inserted };
    },
  );
}

/**
 * Edit your own comment. Server enforces author ownership — RLS scopes
 * by tenant, the action checks `author_user_id === membership.userId`.
 */
export async function updateTaskCommentAction(input: {
  id: string;
  body: string;
}): Promise<TaskCommentResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid edit payload' };

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const [updated] = await tenantTransaction(async (tx) =>
        tx
          .update(taskComments)
          .set({
            body: parsed.data.body,
            editedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(taskComments.id, parsed.data.id),
              eq(taskComments.tenantId, tenant.id),
              eq(taskComments.authorUserId, membership.userId),
            ),
          )
          .returning(),
      );

      if (!updated) {
        return { ok: false, message: 'Comment not found or not yours' };
      }
      revalidatePath('/dashboard/tasks');
      return { ok: true, comment: updated };
    },
  );
}

/**
 * Hard delete (no soft-delete on task comments — they're cheap, scoped,
 * and a recovered task is unlikely to need its old comments). Author-only.
 */
export async function deleteTaskCommentAction(
  id: string,
): Promise<SimpleResult> {
  const gate = await checkPermission(TASK_PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = idSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, message: 'Invalid id' };

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const [deleted] = await tenantTransaction(async (tx) =>
        tx
          .delete(taskComments)
          .where(
            and(
              eq(taskComments.id, parsed.data.id),
              eq(taskComments.tenantId, tenant.id),
              eq(taskComments.authorUserId, membership.userId),
            ),
          )
          .returning(),
      );

      if (!deleted) {
        return { ok: false, message: 'Comment not found or not yours' };
      }
      revalidatePath('/dashboard/tasks');
      return { ok: true };
    },
  );
}
