import { z } from 'zod';

/**
 * Roles the user is allowed to *invite* with from the dashboard. We
 * deliberately exclude 'owner' — ownership is granted only by creating a
 * workspace, never via the invite flow.
 *
 * The invited role is stored directly on the `org_invitations` row and
 * applied verbatim when the invite is accepted — no metadata round-trip.
 */
export const INVITE_ROLES = ['admin', 'manager', 'member'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const INVITE_ROLE_LABELS: Record<InviteRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
};

/**
 * Roles available in the change-role dropdown. All three are persisted
 * directly on the membership row (the local table is the source of truth).
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
 * User id validator. Accepts both legacy Clerk ids (`user_…`, preserved
 * across the migration) and locally-minted ids (`usr_…`).
 */
export const userIdSchema = z
  .string()
  .regex(/^(user|usr)_[A-Za-z0-9]+$/, 'Invalid user id');

/** Invitation ids are UUIDs in the local `org_invitations` table. */
export const invitationIdSchema = z.uuid('Invalid invitation id');

export const changeRoleSchema = z.object({
  userId: userIdSchema,
  role: z.enum(CHANGE_ROLES, { message: 'Pick a role' }),
});

export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
