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

import { ensureTenant, getCurrentTenant } from './tenant';

const KNOWN_ROLES: ReadonlySet<MembershipRole> = new Set([
  'owner',
  'admin',
  'member',
  'viewer',
]);

/**
 * Translate a Clerk role string (e.g. "org:admin", "org:member") into our
 * membership_role enum. Unknown / custom roles fall back to 'member' so we
 * never crash when an org adds a custom role in the Clerk dashboard.
 */
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
 * Insert-or-update a membership row, keyed by (tenant_id, user_id).
 *
 * Owner protection: Clerk has no native "owner" concept (its built-ins are
 * org:admin and org:member). We mint owners ourselves on org.created. To
 * stop a routine `organizationMembership.updated` webhook from silently
 * demoting an owner to admin, we never overwrite an existing 'owner' role
 * with 'admin' — Clerk admin == our owner OR our admin.
 *
 * Race-safe via the (tenant_id, user_id) unique index.
 */
export async function upsertMembership(
  input: UpsertMembershipInput,
): Promise<Membership | null> {
  const [existing] = await db
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

  const [row] = await db
    .insert(memberships)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      role: finalRole,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [memberships.tenantId, memberships.userId],
      set: {
        role: finalRole,
        status: 'active',
      },
    })
    .returning();

  return row ?? null;
}

type ProvisionMembershipInput = {
  clerkOrgId: string;
  clerkUserId: string;
  clerkRole: string | null | undefined;
};

/**
 * Webhook entry point. Looks up the tenant by Clerk org id, then upserts
 * the membership with the mapped role. Returns null if the tenant doesn't
 * exist yet — the caller is expected to provision the tenant first.
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

  return await upsertMembership({
    tenantId: tenant.id,
    userId: input.clerkUserId,
    role: mapClerkRole(input.clerkRole),
  });
}

/**
 * Webhook entry point for organizationMembership.deleted. No-op if the
 * tenant or membership row is already gone.
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

  await db
    .delete(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenant.id),
        eq(memberships.userId, input.clerkUserId),
      ),
    );
}

/**
 * Returns the active user's membership row in the active tenant.
 */
export async function getCurrentMembership(): Promise<Membership | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const [row] = await db
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
}

/**
 * Asserts an active membership exists. Use in protected routes after the
 * middleware has gated on userId + orgId.
 */
export async function requireMembership(): Promise<Membership> {
  const m = await getCurrentMembership();
  if (!m) {
    throw new Error(
      'No active membership. The user is not synced as a member of the active organization.',
    );
  }
  return m;
}

/**
 * Read-or-lazily-provision the current membership. If the membership webhook
 * hasn't fired yet, we backfill from `auth().orgRole` — and if the user is
 * the org's creator (per Clerk), they're minted as 'owner' instead of 'admin'.
 */
export async function ensureMembership(): Promise<Membership | null> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return null;

  const existing = await getCurrentMembership();
  if (existing) return existing;

  const tenant = await ensureTenant();
  if (!tenant) return null;

  // Promote the org creator to 'owner'. Without this branch, the first user
  // would always come back as 'admin' (Clerk's default for the creator) and
  // canManageRoles would be unreachable.
  const client = await clerkClient();
  const org = await client.organizations.getOrganization({ organizationId: orgId });
  const isCreator = org.createdBy === userId;

  return await upsertMembership({
    tenantId: tenant.id,
    userId,
    role: isCreator ? 'owner' : mapClerkRole(orgRole),
  });
}

/* -------- role helpers (kept here for ergonomic import; logic in rbac.ts) -------- */

type RoleBearing = Pick<Membership, 'role'>;

export function isOwner(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner';
}

export function isAdmin(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner' || m?.role === 'admin';
}
