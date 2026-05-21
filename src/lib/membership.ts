import 'server-only';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  type Membership,
  type MembershipRole,
  memberships,
  tenants,
} from '@/db/schema';
import {
  getTenantContext,
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';

import { ensureTenant, getCurrentTenant } from './tenant';

const KNOWN_ROLES: ReadonlySet<MembershipRole> = new Set([
  'owner',
  'admin',
  'manager',
  'member',
  'viewer',
]);

export function mapClerkRole(clerkRole: string | null | undefined): MembershipRole {
  if (!clerkRole) return 'member';
  const stripped = clerkRole.replace(/^org:/, '') as MembershipRole;
  return KNOWN_ROLES.has(stripped) ? stripped : 'member';
}

type UpsertMembershipInput = {
  tenantId: string;
  userId: string;
  role: MembershipRole;
};

/**
 * Insert-or-update a membership, with the owner-protection rule from the
 * RBAC phase intact. Must be called inside a tenant context — RLS on
 * memberships requires `app.tenant_id` to be set.
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

type ProvisionMembershipInput = {
  clerkOrgId: string;
  clerkUserId: string;
  clerkRole: string | null | undefined;
};

/**
 * Webhook entry point. Looks up the tenant via the (non-RLS) `tenants` table
 * directly on `db`, then performs the membership upsert inside a tenant
 * context — caller is expected to have entered `runWithSystemContext`
 * already, but we tolerate either by checking and self-establishing if
 * absent. The self-establish path is needed because `upsertTenantFromOrg`
 * (which runs before this) doesn't set context.
 */
export async function upsertMembershipFromClerk(
  input: ProvisionMembershipInput,
): Promise<Membership | null> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.clerkOrgId, input.clerkOrgId))
    .limit(1);
  if (!tenant) return null;

  const role = mapClerkRole(input.clerkRole);

  const run = () =>
    upsertMembership({
      tenantId: tenant.id,
      userId: input.clerkUserId,
      role,
    });

  if (getTenantContext()) return await run();
  return await runWithTenantContext(
    { tenantId: tenant.id, userId: input.clerkUserId },
    run,
  );
}

/**
 * Webhook entry point for `organizationMembership.deleted`. Same context-or-
 * self-establish dance as upsertMembershipFromClerk.
 */
export async function removeMembershipFromClerk(input: {
  clerkOrgId: string;
  clerkUserId: string;
}): Promise<void> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.clerkOrgId, input.clerkOrgId))
    .limit(1);
  if (!tenant) return;

  const run = async () => {
    await tenantTransaction(async (tx) => {
      await tx
        .delete(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenant.id),
            eq(memberships.userId, input.clerkUserId),
          ),
        );
    });
  };

  if (getTenantContext()) {
    await run();
    return;
  }
  await runWithTenantContext(
    { tenantId: tenant.id, userId: input.clerkUserId },
    run,
  );
}

/**
 * Reads the active user's membership row in the active tenant. Used by
 * permission gates and pages. Self-establishes context if not already in
 * one — required because callers (checkPermission, layouts) may invoke
 * this before any wrapper has set the GUCs.
 */
export async function getCurrentMembership(): Promise<Membership | null> {
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
}

export async function requireMembership(): Promise<Membership> {
  const m = await getCurrentMembership();
  if (!m) {
    throw new Error(
      'No active membership. The user is not synced as a member of the active organization.',
    );
  }
  return m;
}

export async function ensureMembership(): Promise<Membership | null> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return null;

  const existing = await getCurrentMembership();
  if (existing) return existing;

  const tenant = await ensureTenant();
  if (!tenant) return null;

  const client = await clerkClient();
  const org = await client.organizations.getOrganization({ organizationId: orgId });
  const isCreator = org.createdBy === userId;

  const role: MembershipRole = isCreator ? 'owner' : mapClerkRole(orgRole);

  const run = () => upsertMembership({ tenantId: tenant.id, userId, role });

  if (getTenantContext()) return await run();
  return await runWithTenantContext({ tenantId: tenant.id, userId }, run);
}

type RoleBearing = Pick<Membership, 'role'>;

export function isOwner(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner';
}

export function isAdmin(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner' || m?.role === 'admin';
}
