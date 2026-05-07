import 'server-only';

import { auth } from '@clerk/nextjs/server';
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

type ProvisionMembershipInput = {
  clerkOrgId: string;
  clerkUserId: string;
  clerkRole: string | null | undefined;
};

/**
 * Insert or update a membership row for the (tenant, user) pair, keyed by
 * the Clerk org id. Race-safe via ON CONFLICT on the (tenant_id, user_id)
 * unique index. Returns null if no tenant exists for the org yet — the
 * caller (webhook) can decide whether to retry or short-circuit.
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

  const [row] = await db
    .insert(memberships)
    .values({
      tenantId: tenant.id,
      userId: input.clerkUserId,
      role,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [memberships.tenantId, memberships.userId],
      set: {
        role,
        status: 'active',
      },
    })
    .returning();

  return row ?? null;
}

/**
 * Remove a membership row when Clerk reports it deleted. No-op if either the
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
 * Returns the active user's membership row in the active tenant, or null
 * if either is missing.
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
 * middleware has already gated on userId + orgId.
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
 * Read-or-lazily-provision the current membership. Mirrors ensureTenant()
 * for dev/safety: if the membership webhook hasn't fired yet, we backfill
 * from `auth().orgRole`. Race-safe.
 */
export async function ensureMembership(): Promise<Membership | null> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return null;

  const existing = await getCurrentMembership();
  if (existing) return existing;

  const tenant = await ensureTenant();
  if (!tenant) return null;

  return await upsertMembershipFromClerk({
    clerkOrgId: orgId,
    clerkUserId: userId,
    clerkRole: orgRole,
  });
}

/* -------- role helpers -------- */

type RoleBearing = Pick<Membership, 'role'>;

export function isOwner(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner';
}

/**
 * Owners count as admins for permission checks — owner is strictly stronger.
 */
export function isAdmin(m: RoleBearing | null | undefined): boolean {
  return m?.role === 'owner' || m?.role === 'admin';
}
