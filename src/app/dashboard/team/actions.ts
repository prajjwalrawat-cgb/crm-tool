'use server';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { memberships } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';
import {
  deletePendingRoleIntent,
  upsertPendingRoleIntent,
} from '@/lib/team/role-intents';
import { type InviteRole } from '@/lib/team/schema';
import {
  changeRoleSchema,
  clerkInvitationIdSchema,
  clerkUserIdSchema,
  inviteMemberSchema,
} from '@/lib/team/schema';

type ActionResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

function clerkRoleFor(role: InviteRole): 'org:admin' | 'org:member' {
  // Clerk's built-in org roles are admin and member only. Both
  // 'manager' and 'member' map to org:member at the Clerk level —
  // the manager distinction is carried via invitation publicMetadata
  // and resolved locally on acceptance.
  return role === 'admin' ? 'org:admin' : 'org:member';
}

/**
 * Clerk error codes related to "the invited email already exists in
 * Clerk's user space or in some organization". Without further info
 * these are ambiguous — Clerk doesn't always disclose whether the
 * conflict is in THIS org or another. We rewrite them to a single
 * neutral message that doesn't leak which tenant the user belongs to.
 *
 * The phrasing is informative enough to be actionable ("they're in
 * another workspace, ask them to leave or use a different email")
 * without confirming which workspace.
 */
const LEAKY_CLERK_CODES = new Set([
  'user_already_belongs_to_organization',
  'identifier_already_exists',
  'duplicate_record',
]);

/**
 * Codes that specifically mean "this email is already a member of
 * THIS org" (per Clerk's API). When we can tell from the code that
 * the conflict is in-tenant, we say so directly — that's not a leak.
 */
const SAME_ORG_DUPLICATE_CODES = new Set([
  'duplicate_organization_membership',
]);

type ClerkErrorEntry = { code?: string; message?: string };

function describeClerkError(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const errors = (err as { errors?: ClerkErrorEntry[] }).errors;
    const first = errors?.[0];
    if (first?.code && SAME_ORG_DUPLICATE_CODES.has(first.code)) {
      return 'This person is already a member of this workspace.';
    }
    if (first?.code && LEAKY_CLERK_CODES.has(first.code)) {
      return 'User already belongs to another workspace, or has already been invited here.';
    }
    if (first?.message) return first.message;
    const maybeMessage = (err as { message?: string }).message;
    if (maybeMessage) return maybeMessage;
  }
  return fallback;
}

/* -------- INVITE -------- */

export async function inviteMemberAction(formData: FormData): Promise<ActionResult> {
  const gate = await checkPermission('inviteMembers');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { orgId, userId } = await auth();
  if (!orgId || !userId) {
    return { ok: false, message: 'No active organization.' };
  }

  return await runWithTenantContext(
    { tenantId: gate.tenant.id, userId },
    async () => {
      const parsed = inviteMemberSchema.safeParse({
        email: formData.get('email'),
        role: formData.get('role'),
      });
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        return {
          ok: false,
          message: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
          fieldErrors: flat.fieldErrors as Record<string, string[]>,
        };
      }

      let invitationId: string | null = null;
      try {
        const client = await clerkClient();
        const invitation = await client.organizations.createOrganizationInvitation({
          organizationId: orgId,
          emailAddress: parsed.data.email,
          role: clerkRoleFor(parsed.data.role),
          inviterUserId: userId,
          // Carry the app-level role (manager) through Clerk's
          // invitation as a defense-in-depth signal — the actual
          // source of truth is `pending_role_intents` written below.
          publicMetadata: { appRole: parsed.data.role },
        });
        invitationId = invitation.id;
      } catch (err) {
        return {
          ok: false,
          message: describeClerkError(err, 'Failed to send invitation.'),
        };
      }

      const finalInvitationId = invitationId ?? parsed.data.email;

      // Persist the app-role intent BEFORE recording activity / firing
      // realtime so the invitee's first dashboard load can read it
      // even if every other downstream write failed.
      await upsertPendingRoleIntent({
        tenantId: gate.tenant.id,
        email: parsed.data.email,
        appRole: parsed.data.role,
        inviterUserId: userId,
        invitationId,
      });

      await tenantTransaction(async (tx) => {
        await recordActivity(tx, {
          tenantId: gate.tenant.id,
          actorUserId: userId,
          entityType: 'invitation',
          entityId: finalInvitationId,
          action: 'invited',
          metadata: { email: parsed.data.email, role: parsed.data.role },
        });
        await publishRealtimeEvent(tx, {
          type: 'member.invited',
          tenantId: gate.tenant.id,
          email: parsed.data.email,
          role: parsed.data.role,
          invitationId: finalInvitationId,
        });
      });

      await sendWorkflowEvent('crm/member.invited', {
        tenantId: gate.tenant.id,
        email: parsed.data.email,
        role: parsed.data.role,
        invitationId: finalInvitationId,
        inviterUserId: userId,
      });

      revalidatePath('/dashboard/team');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- REVOKE INVITATION -------- */

export async function revokeInvitationAction(
  invitationId: string,
): Promise<ActionResult> {
  const gate = await checkPermission('revokeInvitations');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { orgId, userId } = await auth();
  if (!orgId || !userId) return { ok: false, message: 'No active organization.' };

  return await runWithTenantContext(
    { tenantId: gate.tenant.id, userId },
    async () => {
      const idCheck = clerkInvitationIdSchema.safeParse(invitationId);
      if (!idCheck.success) {
        return { ok: false, message: 'Invalid invitation id.' };
      }

      let revokedEmail: string | null = null;
      try {
        const client = await clerkClient();
        const invitation = await client.organizations.revokeOrganizationInvitation({
          organizationId: orgId,
          invitationId: idCheck.data,
          requestingUserId: userId,
        });
        revokedEmail = invitation.emailAddress ?? null;
      } catch (err) {
        return {
          ok: false,
          message: describeClerkError(err, 'Failed to revoke invitation.'),
        };
      }

      await tenantTransaction(async (tx) => {
        await recordActivity(tx, {
          tenantId: gate.tenant.id,
          actorUserId: userId,
          entityType: 'invitation',
          entityId: idCheck.data,
          action: 'invitation_revoked',
          metadata: revokedEmail ? { email: revokedEmail } : {},
        });
        await publishRealtimeEvent(tx, {
          type: 'member.invitation_revoked',
          tenantId: gate.tenant.id,
          invitationId: idCheck.data,
        });
      });

      revalidatePath('/dashboard/team');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- REMOVE MEMBER -------- */

export async function removeMemberAction(targetUserId: string): Promise<ActionResult> {
  const gate = await checkPermission('removeMembers');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { orgId, userId } = await auth();
  if (!orgId || !userId) return { ok: false, message: 'No active organization.' };

  return await runWithTenantContext(
    { tenantId: gate.tenant.id, userId },
    async () => {
      const idCheck = clerkUserIdSchema.safeParse(targetUserId);
      if (!idCheck.success) return { ok: false, message: 'Invalid user id.' };

      if (idCheck.data === userId) {
        return {
          ok: false,
          message: 'Use the organization switcher to leave the org instead.',
        };
      }

      // Block removing an owner unless the actor is also an owner. Defense in
      // depth on top of the manageRoles permission — admins must not be able to
      // unseat an owner via the remove flow either.
      if (gate.membership.role !== 'owner') {
        // Cheap re-check of the *target's* role via Clerk to avoid a stale read.
        try {
          const client = await clerkClient();
          const memberships = await client.organizations.getOrganizationMembershipList({
            organizationId: orgId,
            limit: 100,
          });
          const target = memberships.data.find(
            (m) => m.publicUserData?.userId === idCheck.data,
          );
          if (target && target.role === 'org:admin') {
            // Clerk admins may include *our* owners. Fail closed: only owners
            // can remove other admins/owners.
            return {
              ok: false,
              message: 'Only an owner can remove an admin or owner.',
            };
          }
        } catch (err) {
          return {
            ok: false,
            message: describeClerkError(err, 'Failed to verify target role.'),
          };
        }
      }

      // Last-admin protection — never let the workspace end up with
      // zero owners/admins. Counts both 'owner' and 'admin' rows in
      // the local memberships table; if the target is one of them and
      // would leave the count at zero, reject.
      const adminsOwners = await tenantTransaction(async (tx) =>
        tx
          .select({ userId: memberships.userId, role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, gate.tenant.id),
              inArray(memberships.role, ['owner', 'admin']),
            ),
          ),
      );
      const targetIsAdminOrOwner = adminsOwners.some(
        (m) => m.userId === idCheck.data,
      );
      if (targetIsAdminOrOwner && adminsOwners.length <= 1) {
        return {
          ok: false,
          message:
            'Cannot remove the last admin or owner. Promote another member first.',
        };
      }

      let targetName: string | null = null;
      let targetEmail: string | null = null;
      try {
        const client = await clerkClient();
        try {
          const target = await client.users.getUser(idCheck.data);
          const parts = [target.firstName, target.lastName].filter(Boolean) as string[];
          targetName = parts.length
            ? parts.join(' ')
            : target.primaryEmailAddress?.emailAddress ?? null;
          targetEmail = target.primaryEmailAddress?.emailAddress ?? null;
        } catch {
          targetName = null;
        }
        await client.organizations.deleteOrganizationMembership({
          organizationId: orgId,
          userId: idCheck.data,
        });
      } catch (err) {
        return {
          ok: false,
          message: describeClerkError(err, 'Failed to remove member.'),
        };
      }

      // Clear any stale pending-role intent for this email so a
      // re-invite at a different role isn't shadowed by a leftover row.
      if (targetEmail) {
        try {
          await deletePendingRoleIntent({
            tenantId: gate.tenant.id,
            email: targetEmail,
          });
        } catch {
          // Non-fatal — the intent table is consumed-on-read anyway.
        }
      }

      await tenantTransaction(async (tx) => {
        // Delete the local memberships row directly. The Clerk webhook
        // would normally fire `organizationMembership.deleted` and our
        // handler would clean up, but webhooks may be slow or absent
        // in dev/local — making the row stale and the admin UI show
        // the removed user. Direct delete eliminates that drift.
        await tx
          .delete(memberships)
          .where(
            and(
              eq(memberships.tenantId, gate.tenant.id),
              eq(memberships.userId, idCheck.data),
            ),
          );
        await recordActivity(tx, {
          tenantId: gate.tenant.id,
          actorUserId: userId,
          entityType: 'membership',
          entityId: idCheck.data,
          action: 'member_removed',
          metadata: {
            targetUserId: idCheck.data,
            ...(targetName ? { targetName } : {}),
          },
        });
        await publishRealtimeEvent(tx, {
          type: 'member.removed',
          tenantId: gate.tenant.id,
          userId: idCheck.data,
          targetName,
        });
      });

      revalidatePath('/dashboard');
      revalidatePath('/dashboard/team');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- CHANGE ROLE -------- */

export async function changeMemberRoleAction(
  formData: FormData,
): Promise<ActionResult> {
  const gate = await checkPermission('manageRoles');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { orgId, userId } = await auth();
  if (!orgId || !userId) return { ok: false, message: 'No active organization.' };

  return await runWithTenantContext(
    { tenantId: gate.tenant.id, userId },
    async () => {
      const parsed = changeRoleSchema.safeParse({
        userId: formData.get('userId'),
        role: formData.get('role'),
      });
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        return {
          ok: false,
          message: flat.formErrors[0] ?? 'Invalid input.',
          fieldErrors: flat.fieldErrors as Record<string, string[]>,
        };
      }

      if (parsed.data.userId === userId) {
        return { ok: false, message: 'You cannot change your own role.' };
      }

      let targetName: string | null = null;
      try {
        const client = await clerkClient();
        try {
          const target = await client.users.getUser(parsed.data.userId);
          const parts = [target.firstName, target.lastName].filter(Boolean) as string[];
          targetName = parts.length
            ? parts.join(' ')
            : target.primaryEmailAddress?.emailAddress ?? null;
        } catch {
          targetName = null;
        }
        // Manager is an app-level role only — Clerk's built-in org
        // roles are admin/member. Set Clerk to "member" for manager;
        // our local memberships table is the source of truth for the
        // manager bit.
        const clerkRole = clerkRoleFor(
          parsed.data.role === 'manager' ? 'member' : parsed.data.role,
        );
        await client.organizations.updateOrganizationMembership({
          organizationId: orgId,
          userId: parsed.data.userId,
          role: clerkRole,
        });
      } catch (err) {
        return {
          ok: false,
          message: describeClerkError(err, 'Failed to update role.'),
        };
      }

      // Persist the role to our memberships table directly. For
      // admin/member the Clerk webhook would also write this — but
      // calling it explicitly avoids a "stale until webhook fires"
      // window. For manager the webhook would write "member" (since
      // that's what Clerk sees), so this direct write is the ONLY
      // source of truth.
      await tenantTransaction(async (tx) => {
        await tx
          .update(memberships)
          .set({ role: parsed.data.role })
          .where(
            and(
              eq(memberships.tenantId, gate.tenant.id),
              eq(memberships.userId, parsed.data.userId),
            ),
          );
        await recordActivity(tx, {
          tenantId: gate.tenant.id,
          actorUserId: userId,
          entityType: 'membership',
          entityId: parsed.data.userId,
          action: 'role_changed',
          metadata: {
            targetUserId: parsed.data.userId,
            to: parsed.data.role,
            ...(targetName ? { targetName } : {}),
          },
        });
        await publishRealtimeEvent(tx, {
          type: 'member.role_changed',
          tenantId: gate.tenant.id,
          userId: parsed.data.userId,
          role: parsed.data.role,
          targetName,
        });
      });

      // Bust the dashboard cache too so the target user's next nav
      // picks up their new persona (sidebar tree, dashboard switcher)
      // without a session refresh.
      revalidatePath('/dashboard');
      revalidatePath('/dashboard/team');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}
