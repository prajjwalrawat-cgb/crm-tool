import { z } from 'zod';

/**
 * Roles the user is allowed to *invite* with from the dashboard. We
 * deliberately exclude 'owner' — owner provisioning happens server-side
 * (organization.created webhook), not via the invite flow.
 *
 * Manager IS in this list, but Clerk's built-in org roles are only
 * admin/member. So the invite flow sends a `org:member` Clerk
 * invitation with `publicMetadata.appRole = 'manager'` — when the
 * invitee accepts, `ensureMembership()` and the Clerk webhook handler
 * both look up that metadata and upgrade the local role to 'manager'.
 */
export const INVITE_ROLES = ['admin', 'manager', 'member'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const INVITE_ROLE_LABELS: Record<InviteRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
};

/**
 * Roles available in the change-role dropdown. Manager is an
 * application-level role that we persist only in our `memberships`
 * table; Clerk's org membership stays at `org:member` for managers
 * (Clerk's built-in roles don't include "manager", and we don't
 * require tenants to configure custom Clerk roles).
 */
export const CHANGE_ROLES = ['admin', 'manager', 'member'] as const;
export type ChangeRole = (typeof CHANGE_ROLES)[number];

export const CHANGE_ROLE_LABELS: Record<ChangeRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
};

export const inviteMemberSchema = z.object({
  email: z
    .email({ message: 'Enter a valid email address' })
    .max(255, 'Email is too long'),
  role: z.enum(INVITE_ROLES, { message: 'Pick a role' }),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/**
 * Server actions that take a Clerk user id (remove member, change role)
 * validate it through this — accepts Clerk's `user_…` prefix only.
 */
export const clerkUserIdSchema = z
  .string()
  .regex(/^user_[A-Za-z0-9]+$/, 'Invalid user id');

/** Same idea for invitation ids (`orginv_…`). */
export const clerkInvitationIdSchema = z
  .string()
  .regex(/^orginv_[A-Za-z0-9]+$/, 'Invalid invitation id');

export const changeRoleSchema = z.object({
  userId: clerkUserIdSchema,
  role: z.enum(CHANGE_ROLES, { message: 'Pick a role' }),
});

export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
