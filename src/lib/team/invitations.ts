import 'server-only';

import { and, eq, isNull, sql } from 'drizzle-orm';

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
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { provisionMembership } from '@/lib/membership';

/**
 * Workspace-invitation lifecycle on the local `org_invitations` table —
 * the self-hosted replacement for Clerk's invitation API. The table is under
 * RLS (0075): admin paths run in the admin's tenant context. The token lookup
 * runs before any tenant context exists, so it goes through the narrow
 * SECURITY DEFINER `org_invitation_by_token()` (one row, by token hash, only
 * while unaccepted and unexpired). Explicit tenant_id filters stay as a
 * second layer.
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
  const [invitation] = await tenantTransaction((tx) =>
    tx
    .insert(orgInvitations)
    .values({
      tenantId: input.tenantId,
      email: normalizeEmail(input.email),
      role: input.role,
      tokenHash: hashToken(token),
      invitedByUserId: input.invitedByUserId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning(),
  );
  return { invitation: invitation!, token };
}

/** Delete an invite by id (scoped to tenant). Returns the email if removed. */
export async function revokeInvitation(input: {
  tenantId: string;
  invitationId: string;
}): Promise<string | null> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .delete(orgInvitations)
      .where(
        and(
          eq(orgInvitations.id, input.invitationId),
          eq(orgInvitations.tenantId, input.tenantId),
        ),
      )
      .returning(),
  );
  return row?.email ?? null;
}

/** Resolve a raw token to its (valid, unexpired, unaccepted) invite + tenant. */
export async function getInvitationByToken(
  token: string,
): Promise<{ invitation: OrgInvitation; tenant: Tenant } | null> {
  const tokenHash = hashToken(token);
  const rows = (await db.execute(
    sql`select * from org_invitation_by_token(${tokenHash})`,
  )) as unknown as Array<{
    id: string;
    tenant_id: string;
    email: string;
    role: MembershipRole;
    invited_by_user_id: string | null;
    expires_at: string | Date;
    accepted_at: string | Date | null;
    created_at: string | Date;
    updated_at: string | Date;
  }>;
  const r = rows[0];
  if (!r) return null;
  // tenants is not tenant-scoped (it is the tenant registry).
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, r.tenant_id))
    .limit(1);
  if (!tenant) return null;
  const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));
  return {
    invitation: {
      id: r.id,
      tenantId: r.tenant_id,
      email: r.email,
      role: r.role,
      tokenHash,
      invitedByUserId: r.invited_by_user_id,
      expiresAt: toDate(r.expires_at),
      acceptedAt: r.accepted_at ? toDate(r.accepted_at) : null,
      createdAt: toDate(r.created_at),
      updatedAt: toDate(r.updated_at),
    },
    tenant,
  };
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

  await runWithTenantContext(
    { tenantId: found.tenant.id, userId: input.userId },
    () =>
      tenantTransaction((tx) =>
        tx
          .update(orgInvitations)
          .set({ acceptedAt: new Date() })
          .where(
            and(
              eq(orgInvitations.id, found.invitation.id),
              eq(orgInvitations.tenantId, found.tenant.id),
              isNull(orgInvitations.acceptedAt),
            ),
          ),
      ),
  );

  return { ok: true, tenant: found.tenant };
}
