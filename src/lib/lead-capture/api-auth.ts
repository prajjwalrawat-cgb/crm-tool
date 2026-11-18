import 'server-only';

import { NextResponse } from 'next/server';

import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import type { Permission } from '@/lib/rbac';

/**
 * Session + permission gate for the lead-capture REST routes. Runs `fn`
 * inside the caller's tenant context, or returns 401/403 JSON.
 */
export async function withApiPermission(
  permission: Permission,
  fn: (ctx: { tenantId: string; userId: string }) => Promise<Response>,
): Promise<Response> {
  let gate;
  try {
    gate = await checkPermission(permission);
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (!gate.ok) return NextResponse.json({ error: 'forbidden', message: gate.message }, { status: 403 });
  const { tenant, membership } = gate;
  return runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, () =>
    fn({ tenantId: tenant.id, userId: membership.userId }),
  );
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
