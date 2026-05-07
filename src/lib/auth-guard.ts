import 'server-only';

import type { Membership, Tenant } from '@/db/schema';

import { requireMembership } from './membership';
import { can, type Permission } from './rbac';
import { requireTenant } from './tenant';

/**
 * Thrown when the active membership lacks a required permission. Carries
 * the requested permission and the role that was rejected so callers can
 * decide how to surface (form error, route error, audit log, …).
 */
export class PermissionDeniedError extends Error {
  readonly permission: Permission;
  readonly role: Membership['role'] | null;

  constructor(permission: Permission, role: Membership['role'] | null) {
    super(`Permission denied: requires "${permission}" (current role: ${role ?? 'none'})`);
    this.name = 'PermissionDeniedError';
    this.permission = permission;
    this.role = role;
  }
}

/**
 * Throws if the active user lacks the permission. Use in pages, layouts,
 * and queries — the dashboard error boundary catches and renders.
 */
export async function requirePermission(permission: Permission): Promise<{
  tenant: Tenant;
  membership: Membership;
}> {
  const tenant = await requireTenant();
  const membership = await requireMembership();
  if (!can(membership.role, permission)) {
    throw new PermissionDeniedError(permission, membership.role);
  }
  return { tenant, membership };
}

export type AuthorizedResult =
  | { ok: true; tenant: Tenant; membership: Membership }
  | { ok: false; message: string };

/**
 * Non-throwing variant for server actions. Returns a discriminated union so
 * the caller can short-circuit with a structured form error rather than
 * letting the error boundary take over.
 */
export async function checkPermission(
  permission: Permission,
): Promise<AuthorizedResult> {
  try {
    const { tenant, membership } = await requirePermission(permission);
    return { ok: true, tenant, membership };
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
}
