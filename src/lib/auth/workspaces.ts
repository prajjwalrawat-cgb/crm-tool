import 'server-only';

import { and, asc, eq } from 'drizzle-orm';
import { cache } from 'react';

import { db } from '@/db';
import { memberships, tenants } from '@/db/schema';
import { getCurrentMembership } from '@/lib/membership';

/**
 * Cross-tenant membership lookups for the session/identity layer (login,
 * workspace switcher, select-org). These run on the base `db` connection,
 * which is Supabase's SUPERUSER `postgres` role and therefore *bypasses*
 * RLS — exactly what's needed here: we must list a user's workspaces
 * before any single tenant context exists. Scoped strictly by `user_id`,
 * so no cross-tenant data leaks.
 */

export type Workspace = {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
};

// Memoized per request: the layout uses this for the switcher list AND
// `canCreateWorkspace` calls it again — `cache()` makes the second call free.
export const listUserWorkspaces = cache(
  async (userId: string): Promise<Workspace[]> => {
    return await db
      .select({
        tenantId: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(tenants.createdAt));
  },
);

/**
 * Workspace creation is restricted to the OWNER of the currently-active
 * workspace. Invite-only: a brand-new user with no workspace yet may NOT
 * self-serve a tenant — they must be invited into one. Members, managers,
 * and admins of the active workspace also cannot create new ones.
 */
export async function canCreateWorkspace(userId: string): Promise<boolean> {
  const ws = await listUserWorkspaces(userId);
  if (ws.length === 0) return false; // invite-only: no self-serve bootstrap
  const membership = await getCurrentMembership();
  return membership?.role === 'owner';
}

/** True if the user is an OWNER of the given workspace. */
export async function isOwnerOf(
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.tenantId, tenantId),
        eq(memberships.role, 'owner'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function userHasMembership(
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)),
    )
    .limit(1);
  return Boolean(row);
}
