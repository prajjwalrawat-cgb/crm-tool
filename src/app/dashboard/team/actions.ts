'use server';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
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
  return role === 'admin' ? 'org:admin' : 'org:member';
}

function describeClerkError(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const maybeErrors = (err as { errors?: Array<{ message?: string }> }).errors;
    if (maybeErrors?.[0]?.message) return maybeErrors[0].message;
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
    });
    invitationId = invitation.id;
  } catch (err) {
    return {
      ok: false,
      message: describeClerkError(err, 'Failed to send invitation.'),
    };
  }

  await recordActivity(db, {
    tenantId: gate.tenant.id,
    actorUserId: userId,
    entityType: 'invitation',
    entityId: invitationId ?? parsed.data.email,
    action: 'invited',
    metadata: { email: parsed.data.email, role: parsed.data.role },
  });

  revalidatePath('/dashboard/team');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}

/* -------- REVOKE INVITATION -------- */

export async function revokeInvitationAction(
  invitationId: string,
): Promise<ActionResult> {
  const gate = await checkPermission('revokeInvitations');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { orgId, userId } = await auth();
  if (!orgId || !userId) return { ok: false, message: 'No active organization.' };

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

  await recordActivity(db, {
    tenantId: gate.tenant.id,
    actorUserId: userId,
    entityType: 'invitation',
    entityId: idCheck.data,
    action: 'invitation_revoked',
    metadata: revokedEmail ? { email: revokedEmail } : {},
  });

  revalidatePath('/dashboard/team');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}

/* -------- REMOVE MEMBER -------- */

export async function removeMemberAction(targetUserId: string): Promise<ActionResult> {
  const gate = await checkPermission('removeMembers');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { orgId, userId } = await auth();
  if (!orgId || !userId) return { ok: false, message: 'No active organization.' };

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

  let targetName: string | null = null;
  try {
    const client = await clerkClient();
    // Capture target's display name before removal so the audit log carries
    // something more useful than the bare user id.
    try {
      const target = await client.users.getUser(idCheck.data);
      const parts = [target.firstName, target.lastName].filter(Boolean) as string[];
      targetName = parts.length
        ? parts.join(' ')
        : target.primaryEmailAddress?.emailAddress ?? null;
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

  await recordActivity(db, {
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

  revalidatePath('/dashboard/team');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}

/* -------- CHANGE ROLE -------- */

export async function changeMemberRoleAction(
  formData: FormData,
): Promise<ActionResult> {
  const gate = await checkPermission('manageRoles');
  if (!gate.ok) return { ok: false, message: gate.message };

  const { orgId, userId } = await auth();
  if (!orgId || !userId) return { ok: false, message: 'No active organization.' };

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
    await client.organizations.updateOrganizationMembership({
      organizationId: orgId,
      userId: parsed.data.userId,
      role: clerkRoleFor(parsed.data.role),
    });
  } catch (err) {
    return {
      ok: false,
      message: describeClerkError(err, 'Failed to update role.'),
    };
  }

  await recordActivity(db, {
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

  revalidatePath('/dashboard/team');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}
