'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { memberships } from '@/db/schema';
import { sendInviteEmail } from '@/lib/auth/email';
import { auth } from '@/lib/auth/server';
import { displayNameForUser, getUserById } from '@/lib/auth/users';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';
import { createInvitation, revokeInvitation } from '@/lib/team/invitations';
import {
  changeRoleSchema,
  invitationIdSchema,
  inviteMemberSchema,
  userIdSchema,
} from '@/lib/team/schema';

type ActionResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

async function nameForUser(userId: string): Promise<string | null> {
  const u = await getUserById(userId);
  return u ? displayNameForUser(u) : null;
}

/* -------- INVITE -------- */

export async function inviteMemberAction(formData: FormData): Promise<ActionResult> {
  const gate = await checkPermission('inviteMembers');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { userId } = await auth();
  if (!userId) return { ok: false, message: 'No active session.' };

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

      const email = parsed.data.email.trim().toLowerCase();

      // Already a member? Reject early — the invite would be a no-op.
      const existingMember = await tenantTransaction(async (tx) =>
        tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(eq(memberships.tenantId, gate.tenant.id)),
      );
      const memberUsers = existingMember.length
        ? await Promise.all(existingMember.map((m) => getUserById(m.userId)))
        : [];
      if (memberUsers.some((u) => u?.email === email)) {
        return { ok: false, message: 'This person is already a member of this workspace.' };
      }

      let token: string;
      let invitationId: string;
      try {
        const created = await createInvitation({
          tenantId: gate.tenant.id,
          email,
          role: parsed.data.role,
          invitedByUserId: userId,
        });
        token = created.token;
        invitationId = created.invitation.id;
      } catch {
        return { ok: false, message: 'Failed to create the invitation.' };
      }

      // Send the invite email (best-effort — the invite row already
      // exists, so a transient email failure doesn't lose the invite).
      try {
        await sendInviteEmail({
          to: email,
          token,
          tenantName: gate.tenant.name,
          inviterName: await nameForUser(userId),
        });
      } catch {
        // Logged inside sendInviteEmail; surface nothing to the inviter.
      }

      await tenantTransaction(async (tx) => {
        await recordActivity(tx, {
          tenantId: gate.tenant.id,
          actorUserId: userId,
          entityType: 'invitation',
          entityId: invitationId,
          action: 'invited',
          metadata: { email, role: parsed.data.role },
        });
        await publishRealtimeEvent(tx, {
          type: 'member.invited',
          tenantId: gate.tenant.id,
          email,
          role: parsed.data.role,
          invitationId,
        });
      });

      await sendWorkflowEvent('crm/member.invited', {
        tenantId: gate.tenant.id,
        email,
        role: parsed.data.role,
        invitationId,
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

  const { userId } = await auth();
  if (!userId) return { ok: false, message: 'No active session.' };

  return await runWithTenantContext(
    { tenantId: gate.tenant.id, userId },
    async () => {
      const idCheck = invitationIdSchema.safeParse(invitationId);
      if (!idCheck.success) {
        return { ok: false, message: 'Invalid invitation id.' };
      }

      let revokedEmail: string | null = null;
      try {
        revokedEmail = await revokeInvitation({
          tenantId: gate.tenant.id,
          invitationId: idCheck.data,
        });
      } catch {
        return { ok: false, message: 'Failed to revoke invitation.' };
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

  const { userId } = await auth();
  if (!userId) return { ok: false, message: 'No active session.' };

  return await runWithTenantContext(
    { tenantId: gate.tenant.id, userId },
    async () => {
      const idCheck = userIdSchema.safeParse(targetUserId);
      if (!idCheck.success) return { ok: false, message: 'Invalid user id.' };

      if (idCheck.data === userId) {
        return {
          ok: false,
          message: 'Use the workspace switcher to leave the workspace instead.',
        };
      }

      // Load all owner/admin rows once — drives both the owner-protection
      // check (only an owner can remove an admin/owner) and the
      // last-admin protection.
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

      if (targetIsAdminOrOwner && gate.membership.role !== 'owner') {
        return { ok: false, message: 'Only an owner can remove an admin or owner.' };
      }
      if (targetIsAdminOrOwner && adminsOwners.length <= 1) {
        return {
          ok: false,
          message:
            'Cannot remove the last admin or owner. Promote another member first.',
        };
      }

      const targetName = await nameForUser(idCheck.data);

      await tenantTransaction(async (tx) => {
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

  const { userId } = await auth();
  if (!userId) return { ok: false, message: 'No active session.' };

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

      const targetName = await nameForUser(parsed.data.userId);

      await tenantTransaction(async (tx) => {
        // Guard the last owner/admin: if the target currently is one and
        // demoting them would empty the set, block it.
        const adminsOwners = await tx
          .select({ userId: memberships.userId, role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, gate.tenant.id),
              inArray(memberships.role, ['owner', 'admin']),
            ),
          );
        const targetIsAdminOrOwner = adminsOwners.some(
          (m) => m.userId === parsed.data.userId,
        );
        const demoting = parsed.data.role === 'member' || parsed.data.role === 'manager';
        if (targetIsAdminOrOwner && demoting && adminsOwners.length <= 1) {
          return;
        }

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

      revalidatePath('/dashboard');
      revalidatePath('/dashboard/team');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}
