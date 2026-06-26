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
 *   - manager: team-visibility tier — sees reports, team performance, can
 *     invite members, but cannot edit infrastructure (workflows / AI /
 *     org settings).
 *   - member: read/write basic CRM data. No destructive admin operations.
 *   - viewer: read-only (reserved; not in any write permission).
 */
const PERMISSIONS = {
  manageMembers: ['owner', 'admin'],
  inviteMembers: ['owner', 'admin', 'manager'],
  revokeInvitations: ['owner', 'admin'],
  removeMembers: ['owner', 'admin'],
  /** Only owners may promote/demote roles. Admins cannot mint new admins. */
  manageRoles: ['owner'],

  manageCompanies: ['owner', 'admin', 'manager', 'member'],
  deleteCompanies: ['owner', 'admin'],
  // Restore mirrors delete: anyone authorized to soft-delete may
  // recover their own (or a peer's) action. Without this, admins
  // who deleted a row by mistake cannot recover it themselves.
  restoreCompanies: ['owner', 'admin'],
  // Permanent delete is destructive and irreversible — owner only.
  hardDeleteCompanies: ['owner'],

  manageContacts: ['owner', 'admin', 'manager', 'member'],
  deleteContacts: ['owner', 'admin'],
  restoreContacts: ['owner', 'admin'],
  hardDeleteContacts: ['owner'],

  manageDeals: ['owner', 'admin', 'manager', 'member'],
  deleteDeals: ['owner', 'admin'],
  restoreDeals: ['owner', 'admin'],
  hardDeleteDeals: ['owner'],
  /**
   * Assigning a deal owner to *someone else*. Only owner + manager. A
   * manager additionally cannot assign to an owner (enforced separately,
   * since that depends on the target's role, not just the actor's).
   */
  assignDeals: ['owner', 'manager'],
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
export const canRestoreCompanies = (role: RoleArg) => can(role, 'restoreCompanies');

export const canManageContacts = (role: RoleArg) => can(role, 'manageContacts');
export const canDeleteContacts = (role: RoleArg) => can(role, 'deleteContacts');
export const canRestoreContacts = (role: RoleArg) => can(role, 'restoreContacts');

export const canManageDeals = (role: RoleArg) => can(role, 'manageDeals');
export const canDeleteDeals = (role: RoleArg) => can(role, 'deleteDeals');
export const canRestoreDeals = (role: RoleArg) => can(role, 'restoreDeals');
export const canAssignDeals = (role: RoleArg) => can(role, 'assignDeals');

export const canHardDeleteCompanies = (role: RoleArg) =>
  can(role, 'hardDeleteCompanies');
export const canHardDeleteContacts = (role: RoleArg) =>
  can(role, 'hardDeleteContacts');
export const canHardDeleteDeals = (role: RoleArg) => can(role, 'hardDeleteDeals');

/** Composite helpers used by the recently-deleted page. */
export const canRestoreAnything = (role: RoleArg) =>
  canRestoreCompanies(role) ||
  canRestoreContacts(role) ||
  canRestoreDeals(role);

export const canHardDeleteAnything = (role: RoleArg) =>
  canHardDeleteCompanies(role) ||
  canHardDeleteContacts(role) ||
  canHardDeleteDeals(role);

/* -------- ranking helper for UI sort/compare -------- */

const RANK: Record<MembershipRole, number> = {
  owner: 30,
  admin: 20,
  manager: 15,
  member: 10,
  viewer: 5,
};

export function compareRoles(a: MembershipRole, b: MembershipRole): number {
  return RANK[a] - RANK[b];
}
