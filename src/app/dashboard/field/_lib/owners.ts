import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { memberships, users } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { fieldUserScope } from '@/lib/field/scope';
import type { FieldActor } from '@/lib/field/types';
import { can } from '@/lib/rbac';

export type OwnerOption = { id: string; name: string };

/**
 * Who the actor may plan meetings for: self, plus (viewFieldTeam roles) every
 * active member in their field scope. Self first, then by name. Must run inside
 * the page's tenant context (withTenantSession).
 */
export async function listOwnersInScope(actor: FieldActor): Promise<OwnerOption[]> {
  const ids = can(actor.role, 'viewFieldTeam') ? (await fieldUserScope(actor)).userIds : [actor.userId];
  const rows = await tenantTransaction((tx) => {
    const conds = [eq(memberships.tenantId, actor.tenantId), eq(memberships.status, 'active')];
    if (ids !== null) conds.push(inArray(memberships.userId, ids.length > 0 ? ids : [actor.userId]));
    return tx
      .select({ id: memberships.userId, firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(...conds));
  });
  const options = rows.map((r) => ({
    id: r.id,
    name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.email || r.id,
  }));
  if (!options.some((o) => o.id === actor.userId)) options.push({ id: actor.userId, name: 'Me' });
  return options.sort((a, b) =>
    a.id === actor.userId ? -1 : b.id === actor.userId ? 1 : a.name.localeCompare(b.name),
  );
}
