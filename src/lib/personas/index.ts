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
