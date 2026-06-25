import 'server-only';

import { and, asc, eq } from 'drizzle-orm';
import { cache } from 'react';

import { db } from '@/db';
import { memberships, tenants } from '@/db/schema';

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
 * Workspace creation is restricted to admins/owners. A brand-new user
 * with no workspace yet is allowed to create their first one (bootstrap),
 * otherwise they could never get in. Any plain member/manager who isn't an
 * admin/owner of at least one workspace cannot create new ones.
 */
export async function canCreateWorkspace(userId: string): Promise<boolean> {
  const ws = await listUserWorkspaces(userId);
  if (ws.length === 0) return true; // bootstrap: first workspace
  return ws.some((w) => w.role === 'owner' || w.role === 'admin');
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
