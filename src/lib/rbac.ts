import type { MembershipRole } from '@/db/schema';

/**
 * Role → permission map. The single source of truth for what each role can do.
 * Adding a new permission is a one-line edit here; nothing else in the app
 * needs to know.
 *
 * Role intent:
 *   - owner: everything, including managing roles and removing other owners.
 *   - admin: CRM management + member management (invite/remove). Cannot
 *     change roles to/from owner.
 *   - member: read/write basic CRM data. No destructive admin operations.
 *   - viewer: read-only (reserved; not in any write permission).
 */
const PERMISSIONS = {
  manageMembers: ['owner', 'admin'],
  inviteMembers: ['owner', 'admin'],
  revokeInvitations: ['owner', 'admin'],
  removeMembers: ['owner', 'admin'],
  /** Only owners may promote/demote roles. Admins cannot mint new admins. */
  manageRoles: ['owner'],

  manageCompanies: ['owner', 'admin', 'member'],
  deleteCompanies: ['owner', 'admin'],

  manageContacts: ['owner', 'admin', 'member'],
  deleteContacts: ['owner', 'admin'],

  manageDeals: ['owner', 'admin', 'member'],
  deleteDeals: ['owner', 'admin'],
} as const satisfies Record<string, readonly MembershipRole[]>;

export type Permission = keyof typeof PERMISSIONS;

const ALLOWED = Object.fromEntries(
  (Object.entries(PERMISSIONS) as Array<[Permission, readonly MembershipRole[]]>).map(
    ([key, roles]) => [key, new Set(roles)],
  ),
) as unknown as Record<Permission, ReadonlySet<MembershipRole>>;

export function can(
  role: MembershipRole | null | undefined,
  permission: Permission,
): boolean {
  if (!role) return false;
  return ALLOWED[permission].has(role);
}

/* -------- named convenience helpers (the API spec'd by the task) -------- */

type RoleArg = MembershipRole | null | undefined;

export const canManageMembers = (role: RoleArg) => can(role, 'manageMembers');
export const canInviteMembers = (role: RoleArg) => can(role, 'inviteMembers');
export const canRevokeInvitations = (role: RoleArg) =>
  can(role, 'revokeInvitations');
export const canRemoveMembers = (role: RoleArg) => can(role, 'removeMembers');
export const canManageRoles = (role: RoleArg) => can(role, 'manageRoles');

export const canManageCompanies = (role: RoleArg) => can(role, 'manageCompanies');
export const canDeleteCompanies = (role: RoleArg) => can(role, 'deleteCompanies');

export const canManageContacts = (role: RoleArg) => can(role, 'manageContacts');
export const canDeleteContacts = (role: RoleArg) => can(role, 'deleteContacts');

export const canManageDeals = (role: RoleArg) => can(role, 'manageDeals');
export const canDeleteDeals = (role: RoleArg) => can(role, 'deleteDeals');

/* -------- ranking helper for UI sort/compare -------- */

const RANK: Record<MembershipRole, number> = {
  owner: 30,
  admin: 20,
  member: 10,
  viewer: 5,
};

export function compareRoles(a: MembershipRole, b: MembershipRole): number {
  return RANK[a] - RANK[b];
}
