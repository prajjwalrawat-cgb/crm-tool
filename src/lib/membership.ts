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

/**
 * Resolve the *application-level* role for a user joining an org. Clerk
 * only knows admin/member; "manager" is an app-level concept carried
 * through two redundant channels:
 *
 *   1. `pending_role_intents` (DB-backed, primary source of truth)
 *   2. Clerk invitation `publicMetadata.appRole` (defense-in-depth)
 *
 * The DB intent is written by the invite action; the resolver looks up
 * the user's email against this table to find the intended role. Clerk
 * metadata is checked as a fallback when the intent row is missing —
 * useful for invitations sent before this table existed.
 *
 * Falls back to `mapClerkRole(clerkRole)` on any error so a Clerk hiccup
 * or DB blip never blocks membership creation.
 */
export async function resolveAppRoleForJoin(input: {
  tenantId: string;
  clerkOrgId: string;
  clerkUserId: string;
  clerkRole: string | null | undefined;
}): Promise<MembershipRole> {
  const baseline = mapClerkRole(input.clerkRole);
  // Admin / owner / viewer get returned as-is; manager promotion only
  // applies when Clerk says member.
  if (baseline !== 'member') return baseline;

  // Fetch the user's email — needed for both intent lookups below.
  let email: string | null = null;
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(input.clerkUserId);
    email = user.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;
  } catch {
    return baseline;
  }
  if (!email) return baseline;

  // Primary source: DB-backed intent table. Consumed-on-read — once
  // we've used the intent to provision a role, delete it so a future
  // re-invite at a different role isn't fooled by a stale row. If the
  // membership write fails downstream, the resolver simply falls back
  // to Clerk metadata on the next attempt.
  try {
    const { readPendingRoleIntent, deletePendingRoleIntent } = await import(
      '@/lib/team/role-intents'
    );
    const intent = await readPendingRoleIntent({
      tenantId: input.tenantId,
      email,
    });
    if (intent) {
      await deletePendingRoleIntent({
        tenantId: input.tenantId,
        email,
      });
      return intent.appRole;
    }
  } catch {
    // Fall through to Clerk-metadata path if DB is unreachable.
  }

  // Fallback: Clerk invitation publicMetadata.
  try {
    const client = await clerkClient();
    const invitations = await client.organizations.getOrganizationInvitationList({
      organizationId: input.clerkOrgId,
      status: ['accepted', 'pending'],
      limit: 100,
    });
    const match = invitations.data.find(
      (i) => i.emailAddress?.toLowerCase() === email,
    );
    const appRole = match?.publicMetadata?.appRole;
    if (appRole === 'manager') return 'manager';
    if (appRole === 'admin') return 'admin';
    return baseline;
  } catch {
    return baseline;
  }
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

  // Webhook delivery: Clerk only knows admin/member, but the inviter
  // may have stamped `appRole=manager` on the invitation. Resolve here
  // so the very first membership row already has the correct role.
  const role = await resolveAppRoleForJoin({
    tenantId: tenant.id,
    clerkOrgId: input.clerkOrgId,
    clerkUserId: input.clerkUserId,
    clerkRole: input.clerkRole,
  });

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

/**
 * Sentinel error class for "Clerk says you're in this org, but our DB
 * has no membership row for you in this tenant." Used by
 * `dashboard/error.tsx` to render a recovery UI (silent retry + switch
 * org) instead of a generic crash screen.
 */
export class MembershipMissingError extends Error {
  static readonly NAME = 'MembershipMissingError';
  constructor() {
    super(
      'No active membership. The user is not synced as a member of the active organization.',
    );
    this.name = MembershipMissingError.NAME;
  }
}

export async function requireMembership(): Promise<Membership> {
  let m = await getCurrentMembership();
  // Self-heal: if no row exists, run ensureMembership once. Covers the
  // dev case where Clerk webhooks aren't firing and the user landed on
  // a page before the dashboard layout's own ensure call seeded the row.
  if (!m) {
    m = await ensureMembership();
  }
  if (!m) {
    throw new MembershipMissingError();
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

  // For non-creators, run the same invitation-metadata resolver the
  // webhook uses — covers local dev (no webhook) and any race where
  // the user hits SSR before the webhook lands.
  const role: MembershipRole = isCreator
    ? 'owner'
    : await resolveAppRoleForJoin({
        tenantId: tenant.id,
        clerkOrgId: orgId,
        clerkUserId: userId,
        clerkRole: orgRole,
      });

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
