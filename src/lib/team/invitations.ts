import 'server-only';

import { and, eq, gt, isNull } from 'drizzle-orm';

import { db } from '@/db';
import {
  type MembershipRole,
  type OrgInvitation,
  orgInvitations,
  type Tenant,
  tenants,
} from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { normalizeEmail } from '@/lib/auth/users';
import { provisionMembership } from '@/lib/membership';

/**
 * Workspace-invitation lifecycle on the local `org_invitations` table —
 * the self-hosted replacement for Clerk's invitation API. Tenant isolation
 * is enforced by always filtering on `tenant_id` (this table is not RLS).
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Create an invite and return the raw token (emailed once, never stored). */
export async function createInvitation(input: {
  tenantId: string;
  email: string;
  role: MembershipRole;
  invitedByUserId: string;
}): Promise<{ invitation: OrgInvitation; token: string }> {
  const token = generateToken();
  const [invitation] = await db
    .insert(orgInvitations)
    .values({
      tenantId: input.tenantId,
      email: normalizeEmail(input.email),
      role: input.role,
      tokenHash: hashToken(token),
      invitedByUserId: input.invitedByUserId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();
  return { invitation: invitation!, token };
}

/** Delete an invite by id (scoped to tenant). Returns the email if removed. */
export async function revokeInvitation(input: {
  tenantId: string;
  invitationId: string;
}): Promise<string | null> {
  const [row] = await db
    .delete(orgInvitations)
    .where(
      and(
        eq(orgInvitations.id, input.invitationId),
        eq(orgInvitations.tenantId, input.tenantId),
      ),
    )
    .returning();
  return row?.email ?? null;
}

/** Resolve a raw token to its (valid, unexpired, unaccepted) invite + tenant. */
export async function getInvitationByToken(
  token: string,
): Promise<{ invitation: OrgInvitation; tenant: Tenant } | null> {
  const [row] = await db
    .select({ invitation: orgInvitations, tenant: tenants })
    .from(orgInvitations)
    .innerJoin(tenants, eq(orgInvitations.tenantId, tenants.id))
    .where(
      and(
        eq(orgInvitations.tokenHash, hashToken(token)),
        isNull(orgInvitations.acceptedAt),
        gt(orgInvitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Accept an invite: verify the email matches, provision the membership at
 * the invited role, and mark the invite consumed. Idempotent-ish — a
 * second accept finds the invite already marked and returns an error.
 */
export async function acceptInvitation(input: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<{ ok: true; tenant: Tenant } | { ok: false; message: string }> {
  const found = await getInvitationByToken(input.token);
  if (!found) {
    return { ok: false, message: 'This invitation is invalid or has expired.' };
  }
  if (normalizeEmail(input.userEmail) !== found.invitation.email) {
    return {
      ok: false,
      message: 'This invitation was sent to a different email address.',
    };
  }

  await provisionMembership({
    tenantId: found.tenant.id,
    userId: input.userId,
    role: found.invitation.role,
  });

  await db
    .update(orgInvitations)
    .set({ acceptedAt: new Date() })
    .where(eq(orgInvitations.id, found.invitation.id));

  return { ok: true, tenant: found.tenant };
}
