import 'server-only';

import { sql, type SQL } from 'drizzle-orm';

import type { MembershipRole } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Report scoping — the single helper every manager-report query goes
 * through. No report reads data for a user set it did not get from here.
 *
 *   owner / admin → the whole tenant
 *   manager       → self + everyone below them in the reporting line
 *                   (memberships.reports_to_user_id, recursive). A manager
 *                   with nobody reporting to them yet sees the whole tenant
 *                   — the pre-0074 behaviour — and `fallback` is true so the
 *                   UI can say "set up reporting lines to narrow this".
 *   member/viewer → self only
 *
 * Tenant isolation is separate and always on (RLS + tenant_id predicates).
 */
export type ReportScope = {
  tenantId: string;
  viewerUserId: string;
  role: MembershipRole;
  /** null = every user in the tenant. */
  userIds: string[] | null;
  /** Manager with no configured reports: widened to the tenant. */
  fallback: boolean;
};

export type ScopeInput = { tenantId: string; userId: string; role: MembershipRole };

export async function scopeUsers(m: ScopeInput): Promise<ReportScope> {
  const base = { tenantId: m.tenantId, viewerUserId: m.userId, role: m.role };
  if (m.role === 'owner' || m.role === 'admin') return { ...base, userIds: null, fallback: false };
  if (m.role !== 'manager') return { ...base, userIds: [m.userId], fallback: false };

  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT user_id, 0 AS depth FROM memberships
         WHERE tenant_id = ${m.tenantId}::uuid AND user_id = ${m.userId}
        UNION
        SELECT mm.user_id, t.depth + 1 FROM memberships mm
          JOIN tree t ON mm.reports_to_user_id = t.user_id
         WHERE mm.tenant_id = ${m.tenantId}::uuid AND t.depth < 20
      )
      SELECT DISTINCT user_id FROM tree`),
  )) as unknown as Array<{ user_id: string }>;
  const ids = [...new Set([m.userId, ...rows.map((r) => r.user_id)])];
  if (ids.length <= 1) return { ...base, userIds: null, fallback: true };
  return { ...base, userIds: ids, fallback: false };
}

/** True if `userId` is inside the scope. */
export function scopeIncludes(scope: ReportScope, userId: string | null): boolean {
  if (scope.userIds === null) return true;
  return userId !== null && scope.userIds.includes(userId);
}

/** A Postgres text[] literal bound as ONE parameter (drizzle expands JS arrays into tuples). */
export function textArray(values: string[]): SQL {
  const lit = `{${values.map((v) => `"${v.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
  return sql`${lit}::text[]`;
}

/**
 * `<column> IN scope` as SQL. Tenant scope → TRUE (unowned rows included);
 * user scope → owner in the list (unowned rows excluded).
 */
export function ownerIn(scope: ReportScope, column: SQL): SQL {
  if (scope.userIds === null) return sql`TRUE`;
  return sql`${column} = ANY(${textArray(scope.userIds)})`;
}

/**
 * Narrow a scope to one owner, if that owner is inside it. A user asking for
 * someone outside their scope gets an empty scope, never a widened one.
 */
export function narrowToOwner(scope: ReportScope, ownerId: string | null | undefined): ReportScope {
  if (!ownerId) return scope;
  return { ...scope, userIds: scopeIncludes(scope, ownerId) ? [ownerId] : [], fallback: false };
}
