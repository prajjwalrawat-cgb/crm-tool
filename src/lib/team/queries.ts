import 'server-only';

import { and, asc, eq, gt, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { type Membership, memberships, orgInvitations } from '@/db/schema';
import { clerkClient } from '@/lib/auth/server';
import { tenantTransaction } from '@/lib/db-context';

export type TeamMemberRow = Membership & {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
};

export type PendingInvitationRow = {
  id: string;
  emailAddress: string;
  role: string;
  createdAt: Date;
};

export async function listTeamMembers(tenantId: string): Promise<TeamMemberRow[]> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(asc(memberships.createdAt)),
  );

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
      imageUrl: u?.imageUrl || null,
    };
  });
}

/**
 * Outstanding (unaccepted, unexpired) workspace invitations for a tenant.
 * Reads the local `org_invitations` table — the self-hosted replacement
 * for Clerk's invitation list. Filtered explicitly on `tenant_id` (this
 * table is not under RLS).
 */
export async function listPendingInvitations(
  tenantId: string,
): Promise<PendingInvitationRow[]> {
  const rows = await db
    .select()
    .from(orgInvitations)
    .where(
      and(
        eq(orgInvitations.tenantId, tenantId),
        isNull(orgInvitations.acceptedAt),
        gt(orgInvitations.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(orgInvitations.createdAt));

  return rows.map((inv) => ({
    id: inv.id,
    emailAddress: inv.email,
    role: inv.role,
    createdAt: inv.createdAt,
  }));
}
