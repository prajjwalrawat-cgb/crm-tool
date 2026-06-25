import 'server-only';

import { and, eq } from 'drizzle-orm';
import { cache } from 'react';

import {
  type Membership,
  type MembershipRole,
  memberships,
} from '@/db/schema';
import { auth } from '@/lib/auth/server';
import {
  getTenantContext,
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';

import { getCurrentTenant } from './tenant';

type UpsertMembershipInput = {
  tenantId: string;
  userId: string;
  role: MembershipRole;
};

/**
 * Insert-or-update a membership, preserving the owner-protection rule:
 * an existing owner is never silently downgraded to admin. Must be called
 * inside a tenant context — RLS on memberships requires `app.tenant_id`.
 */
export async function upsertMembership(
  input: UpsertMembershipInput,
): Promise<Membership | null> {
  return await tenantTransaction(async (tx) => {
    const [existing] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.userId, input.userId),
        ),
      )
      .limit(1);

    const finalRole: MembershipRole =
      existing?.role === 'owner' && input.role === 'admin' ? 'owner' : input.role;

    const [row] = await tx
      .insert(memberships)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        role: finalRole,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: { role: finalRole, status: 'active' },
      })
      .returning();

    return row ?? null;
  });
}

/**
 * Provision a membership for a user joining a workspace (invite accept).
 * Self-establishes a tenant context if the caller hasn't entered one.
 */
export async function provisionMembership(input: {
  tenantId: string;
  userId: string;
  role: MembershipRole;
}): Promise<Membership | null> {
  const run = () => upsertMembership(input);
  if (getTenantContext()) return await run();
  return await runWithTenantContext(
    { tenantId: input.tenantId, userId: input.userId },
    run,
  );
}

/**
 * Reads the active user's membership row in the active tenant. Used by
 * permission gates and pages. Self-establishes context if not already in
 * one — required because callers may invoke this before any wrapper has
 * set the GUCs.
 */
export const getCurrentMembership = cache(async (): Promise<Membership | null> => {
  const { userId } = await auth();
  if (!userId) return null;

  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const run = async () =>
    await tenantTransaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenant.id),
            eq(memberships.userId, userId),
          ),
        )
        .limit(1);
      return row ?? null;
    });

  if (getTenantContext()) return await run();
  return await runWithTenantContext({ tenantId: tenant.id, userId }, run);
});

/**
 * Backstop used by the dashboard layout. With local auth a membership is
 * always provisioned at workspace-create / invite-accept time, so this is
 * just `getCurrentMembership` — kept as a named export so the layout call
 * site is unchanged.
 */
export async function ensureMembership(): Promise<Membership | null> {
  return await getCurrentMembership();
}

/**
 * Sentinel error: the session has an active tenant but no membership row
 * exists for the user in it. `dashboard/error.tsx` renders a recovery UI
 * instead of a generic crash.
 */
export class MembershipMissingError extends Error {
  static readonly NAME = 'MembershipMissingError';
  constructor() {
    super(
      'No active membership. The user is not a member of the active workspace.',
    );
    this.name = MembershipMissingError.NAME;
  }
}

export async function requireMembership(): Promise<Membership> {
  const m = await getCurrentMembership();
  if (!m) {
    throw new MembershipMissingError();
  }
  return m;
}

type RoleBearing = Pick<Membership, 'role'>;

export function isOwner(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner';
}

export function isAdmin(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner' || m?.role === 'admin';
}
