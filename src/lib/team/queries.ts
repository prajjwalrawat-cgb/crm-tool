import 'server-only';

import { clerkClient } from '@clerk/nextjs/server';
import { asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { type Membership, memberships } from '@/db/schema';

export type TeamMemberRow = Membership & {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
};

export type PendingInvitationRow = {
  id: string;
  emailAddress: string;
  /** Raw Clerk role string, e.g. "org:admin" / "org:member". */
  role: string;
  createdAt: Date;
};

/**
 * Materialize the membership rows for a tenant alongside the matching
 * Clerk user records (email, name, image). One DB query + one batched
 * Clerk call regardless of N — `users.getUserList({ userId: [...] })`
 * accepts up to 500 ids per request, which comfortably covers a tenant.
 */
export async function listTeamMembers(tenantId: string): Promise<TeamMemberRow[]> {
  const rows = await db
    .select()
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(asc(memberships.createdAt));

  if (rows.length === 0) return [];

  const client = await clerkClient();
  const userList = await client.users.getUserList({
    userId: rows.map((r) => r.userId),
    limit: 500,
  });

  const userMap = new Map(userList.data.map((u) => [u.id, u]));

  return rows.map((r) => {
    const u = userMap.get(r.userId);
    return {
      ...r,
      email: u?.primaryEmailAddress?.emailAddress ?? null,
      firstName: u?.firstName ?? null,
      lastName: u?.lastName ?? null,
      imageUrl: u?.imageUrl ?? null,
    };
  });
}

/**
 * Pending invitations for an org, fetched live from Clerk. We don't mirror
 * these in our DB — invitations have no user_id until accepted, so the
 * memberships table can't represent them naturally without a side column.
 */
export async function listPendingInvitations(
  clerkOrgId: string,
): Promise<PendingInvitationRow[]> {
  const client = await clerkClient();
  const result = await client.organizations.getOrganizationInvitationList({
    organizationId: clerkOrgId,
    status: ['pending'],
    limit: 100,
  });

  return result.data.map((inv) => ({
    id: inv.id,
    emailAddress: inv.emailAddress,
    role: inv.role,
    createdAt: new Date(inv.createdAt),
  }));
}
