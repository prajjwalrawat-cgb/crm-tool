import type { MembershipRole } from '@/db/schema';

/**
 * Personas are the UX layer over roles. They drive what sidebar nav,
 * dashboard composition, and AI defaults a user sees — without
 * changing the underlying authorization model (which stays on the
 * MembershipRole + RBAC permission map).
 *
 * Mapping:
 *   owner + admin → 'admin'
 *   manager       → 'manager'
 *   member + viewer → 'sales'
 *
 * Default when no role is resolvable: 'sales' (least-privileged UX).
 * Permissions still flow through `can(role, permission)` — persona
 * never grants capability, only shapes presentation.
 */

export const PERSONAS = ['sales', 'manager', 'admin'] as const;
export type Persona = (typeof PERSONAS)[number];

export function personaOf(role: MembershipRole | null | undefined): Persona {
  if (!role) return 'sales';
  switch (role) {
    case 'owner':
    case 'admin':
      return 'admin';
    case 'manager':
      return 'manager';
    case 'member':
    case 'viewer':
    default:
      return 'sales';
  }
}

/**
 * Display label for a persona — used in headers, audit strings,
 * and the user-facing role chip.
 */
export const PERSONA_LABELS: Record<Persona, string> = {
  sales: 'Sales',
  manager: 'Manager',
  admin: 'Administrator',
};

/**
 * The CRM's record-visibility rule for deals, companies and contacts: the sales
 * persona (member, viewer) sees records they own plus unassigned ones; managers,
 * admins and owners see the whole tenant. Returns the owner id to restrict to, or
 * undefined for no restriction. Used by the list pages, /api/search and the Field
 * meeting pickers so every surface shows the same records.
 */
export function ownerOrUnassignedRestriction(
  role: MembershipRole | null | undefined,
  userId: string,
): string | undefined {
  return personaOf(role) === 'sales' ? userId : undefined;
}
