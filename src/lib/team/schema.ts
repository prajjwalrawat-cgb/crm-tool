import { z } from 'zod';

/**
 * Roles the user is allowed to *invite* with from the dashboard. We
 * deliberately exclude 'owner' — owner provisioning happens server-side
 * (organization.created webhook), not via the invite flow. Inviting an
 * owner via the UI would also need a distinct permission anyway.
 */
export const INVITE_ROLES = ['admin', 'member'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

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
  role: z.enum(INVITE_ROLES, { message: 'Pick a role' }),
});

export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
