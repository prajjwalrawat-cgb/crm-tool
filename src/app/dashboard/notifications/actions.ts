'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { notifications } from '@/db/schema';
import { checkPermission } from '@/lib/auth-guard';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';

const idSchema = z.object({ id: z.uuid() });

export type NotificationActionResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Mark a single notification read. RLS already constrains the UPDATE
 * to the recipient's own rows, so the explicit predicate is belt-
 * and-suspenders.
 *
 * Permission gate: any tenant member can manage their own
 * notifications. We reuse `manageDeals` as a stand-in for "is a real
 * tenant member" — the gate's actual job here is to refuse
 * unauthenticated calls and resolve the tenant context.
 */
export async function markNotificationReadAction(
  id: string,
): Promise<NotificationActionResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = idSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, message: 'Invalid id' };

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await tenantTransaction(async (tx) => {
        await tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.id, parsed.data.id),
              eq(notifications.recipientUserId, membership.userId),
              isNull(notifications.readAt),
            ),
          );
      });
      revalidatePath('/dashboard');
      return { ok: true };
    },
  );
}

export async function markAllNotificationsReadAction(): Promise<NotificationActionResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await tenantTransaction(async (tx) => {
        await tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.tenantId, tenant.id),
              eq(notifications.recipientUserId, membership.userId),
              isNull(notifications.readAt),
            ),
          );
      });
      revalidatePath('/dashboard');
      return { ok: true };
    },
  );
}
