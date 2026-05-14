'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { comments, type Comment } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  commentPreview,
  extractMentionUserIds,
} from '@/lib/comments/mentions';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

const ENTITY_TYPES = ['deal', 'company', 'contact'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const PERMISSION_FOR: Record<EntityType, 'manageDeals' | 'manageCompanies' | 'manageContacts'> = {
  deal: 'manageDeals',
  company: 'manageCompanies',
  contact: 'manageContacts',
};

const PATH_FOR: Record<EntityType, (id: string) => string> = {
  deal: (id) => `/dashboard/deals/${id}`,
  company: (id) => `/dashboard/companies/${id}`,
  contact: (id) => `/dashboard/contacts/${id}`,
};

const createSchema = z.object({
  body: z.string().min(1, 'Comment can’t be empty').max(8000),
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.uuid(),
  parentCommentId: z.uuid().optional().nullable(),
});

const updateSchema = z.object({
  id: z.uuid(),
  body: z.string().min(1).max(8000),
});

const idSchema = z.object({ id: z.uuid() });

export type CommentResult =
  | { ok: true; comment: Comment }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export type SimpleCommentResult =
  | { ok: true }
  | { ok: false; message: string };

export async function createCommentAction(input: {
  body: string;
  entityType: EntityType;
  entityId: string;
  parentCommentId?: string | null;
}): Promise<CommentResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: flat.formErrors[0] ?? 'Invalid comment input.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  const gate = await checkPermission(PERMISSION_FOR[parsed.data.entityType]);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const mentions = extractMentionUserIds(parsed.data.body);

      const inserted = await tenantTransaction(async (tx) => {
        // Normalize threading: replies-to-replies collapse to the
        // top-level ancestor. Keeps the UI's depth==1 promise even
        // if a buggy client sends a deeper parent.
        let parentId: string | null = parsed.data.parentCommentId ?? null;
        if (parentId) {
          const [parent] = await tx
            .select({
              id: comments.id,
              parentCommentId: comments.parentCommentId,
            })
            .from(comments)
            .where(
              and(
                eq(comments.id, parentId),
                eq(comments.tenantId, tenant.id),
                isNull(comments.deletedAt),
              ),
            )
            .limit(1);
          if (parent?.parentCommentId) {
            // Normalize: point at the top-level ancestor.
            parentId = parent.parentCommentId;
          } else if (!parent) {
            parentId = null;
          }
        }

        const [row] = await tx
          .insert(comments)
          .values({
            tenantId: tenant.id,
            entityType: parsed.data.entityType,
            entityId: parsed.data.entityId,
            authorUserId: membership.userId,
            parentCommentId: parentId,
            body: parsed.data.body.trim(),
            mentionedUserIds: mentions,
          })
          .returning();
        if (!row) throw new Error('Insert failed');

        const preview = commentPreview(row.body, 80);

        // Activity log on the parent entity so the unified timeline
        // surfaces "X commented on Acme deal" alongside other actions.
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          action: 'updated',
          metadata: {
            commentId: row.id,
            commentPreview: preview,
            kind: 'comment',
          },
        });

        // Realtime publish — every open thread on this entity merges
        // the new comment without a refresh. The thread component
        // filters by (entityType, entityId) so other rooms ignore it.
        await publishRealtimeEvent(tx, {
          type: 'comment.created',
          tenantId: tenant.id,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          comment: {
            id: row.id,
            tenantId: row.tenantId,
            entityType: row.entityType,
            entityId: row.entityId,
            authorUserId: row.authorUserId,
            authorDisplayName: null,
            parentCommentId: row.parentCommentId,
            body: row.body,
            mentionedUserIds: row.mentionedUserIds,
            editedAt: row.editedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          },
        });

        return { row, mentions, preview };
      });

      // Post-commit, best-effort mention fan-out. Mention failures must
      // never roll back the comment itself.
      if (inserted.mentions.length > 0) {
        await recordNotificationsSafe(
          {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            type: 'comment_mention',
            title: 'Mentioned you in a comment',
            subtitle: inserted.preview,
            entityType: parsed.data.entityType,
            entityId: parsed.data.entityId,
            metadata: { commentId: inserted.row.id },
          },
          inserted.mentions,
        );
      }

      revalidatePath(PATH_FOR[parsed.data.entityType](parsed.data.entityId));
      return { ok: true, comment: inserted.row };
    },
  );
}

export async function updateCommentAction(input: {
  id: string;
  body: string;
}): Promise<CommentResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid comment input.' };
  }

  const gate = await checkPermission('manageDeals'); // weakest gate for read
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const existing = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.id, parsed.data.id),
              eq(comments.tenantId, tenant.id),
              isNull(comments.deletedAt),
            ),
          )
          .limit(1),
      );
      const c = existing[0];
      if (!c) return { ok: false, message: 'Comment not found' };
      if (c.authorUserId !== membership.userId) {
        return { ok: false, message: 'You can only edit your own comments.' };
      }

      const mentions = extractMentionUserIds(parsed.data.body);
      const updated = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(comments)
          .set({
            body: parsed.data.body.trim(),
            mentionedUserIds: mentions,
            editedAt: new Date(),
          })
          .where(eq(comments.id, parsed.data.id))
          .returning();
        if (!row) throw new Error('Update failed');
        return row;
      });

      revalidatePath(
        PATH_FOR[c.entityType as EntityType](c.entityId),
      );
      return { ok: true, comment: updated };
    },
  );
}

export async function deleteCommentAction(
  id: string,
): Promise<SimpleCommentResult> {
  const parsed = idSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, message: 'Invalid id' };

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const existing = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.id, parsed.data.id),
              eq(comments.tenantId, tenant.id),
              isNull(comments.deletedAt),
            ),
          )
          .limit(1),
      );
      const c = existing[0];
      if (!c) return { ok: true }; // idempotent
      if (c.authorUserId !== membership.userId) {
        return { ok: false, message: 'You can only delete your own comments.' };
      }

      await tenantTransaction(async (tx) => {
        await tx
          .update(comments)
          .set({ deletedAt: new Date(), deletedBy: membership.userId })
          .where(eq(comments.id, parsed.data.id));
      });

      revalidatePath(
        PATH_FOR[c.entityType as EntityType](c.entityId),
      );
      return { ok: true };
    },
  );
}
