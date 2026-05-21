import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  type MembershipRole,
  pendingRoleIntents,
  type PendingRoleIntent,
} from '@/db/schema';

/**
 * DB-backed source of "what role should this invited email get?".
 * Written by the invite action, read by `resolveAppRoleForJoin` on
 * the user's first membership-creation, deleted once consumed.
 *
 * All helpers run on the unrestricted `db` (not RLS-wrapped) because:
 *   1. The invite action is already inside a tenant context — passing
 *      tenantId explicitly preserves isolation without needing app.tenant_id.
 *   2. The webhook handler runs in a system context where `app.tenant_id`
 *      isn't always set; it needs to look up by tenantId directly.
 *   3. The composite primary key (tenantId, emailLc) is the actual
 *      tenant fence — there's no way to read another tenant's intents.
 */

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function upsertPendingRoleIntent(input: {
  tenantId: string;
  email: string;
  appRole: MembershipRole;
  inviterUserId: string;
  invitationId: string | null;
}): Promise<void> {
  const emailLc = normaliseEmail(input.email);
  await db
    .insert(pendingRoleIntents)
    .values({
      tenantId: input.tenantId,
      emailLc,
      appRole: input.appRole,
      inviterUserId: input.inviterUserId,
      invitationId: input.invitationId,
    })
    .onConflictDoUpdate({
      target: [pendingRoleIntents.tenantId, pendingRoleIntents.emailLc],
      set: {
        appRole: input.appRole,
        inviterUserId: input.inviterUserId,
        invitationId: input.invitationId,
      },
    });
}

export async function readPendingRoleIntent(input: {
  tenantId: string;
  email: string;
}): Promise<PendingRoleIntent | null> {
  const emailLc = normaliseEmail(input.email);
  const [row] = await db
    .select()
    .from(pendingRoleIntents)
    .where(
      and(
        eq(pendingRoleIntents.tenantId, input.tenantId),
        eq(pendingRoleIntents.emailLc, emailLc),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Delete the intent once the membership has been provisioned with the
 * right role. Idempotent — re-running is a no-op.
 */
export async function deletePendingRoleIntent(input: {
  tenantId: string;
  email: string;
}): Promise<void> {
  const emailLc = normaliseEmail(input.email);
  await db
    .delete(pendingRoleIntents)
    .where(
      and(
        eq(pendingRoleIntents.tenantId, input.tenantId),
        eq(pendingRoleIntents.emailLc, emailLc),
      ),
    );
}
