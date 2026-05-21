import {
  Activity,
  BarChart3,
  Brain,
  Briefcase,
  Building2,
  CheckSquare,
  Gauge,
  Inbox,
  LayoutDashboard,
  Radar,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  UserCog,
  UsersRound,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import type { Persona } from '@/lib/personas';

/**
 * Phase 17 stabilization: single dashboard, single layout, single
 * sidebar component. Persona-aware visibility per item — not separate
 * sidebar configs that risk leakage.
 *
 * Each NavItem carries an optional `requirePersona` allowlist. When
 * present, the item is filtered out of the rendered sidebar for any
 * persona NOT in the list. When absent, the item shows for everyone.
 *
 * Route-level enforcement lives in `requirePersonas()` (lib/personas/
 * guards.ts) — a sales user who manually types /dashboard/command-center
 * gets redirected by the page itself. Sidebar filtering is curation;
 * route guards are the actual gate.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * If provided, the item only renders in sidebars for these personas.
   * If omitted, the item renders for everyone (e.g. Home, Deals,
   * Tasks, Contacts, Companies, Communications).
   */
  requirePersona?: readonly Persona[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  // Manager + admin only — sales user gets redirected if they deep-link.
  { href: '/dashboard/executive', label: 'Executive', icon: Sparkles, requirePersona: ['manager', 'admin'] },
  // Admin only — strictly hidden from sales + manager.
  { href: '/dashboard/command-center', label: 'Command Center', icon: Radar, requirePersona: ['admin'] },
  // Manager + admin only.
  { href: '/dashboard/intelligence', label: 'Intelligence', icon: Brain, requirePersona: ['manager', 'admin'] },
  { href: '/dashboard/companies', label: 'Companies', icon: Building2 },
  { href: '/dashboard/contacts', label: 'Contacts', icon: UsersRound },
  { href: '/dashboard/deals', label: 'Deals', icon: Briefcase },
  { href: '/dashboard/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/dashboard/communications', label: 'Communications', icon: Inbox },
  // Manager + admin only.
  { href: '/dashboard/reports', label: 'Reports', icon: BarChart3, requirePersona: ['manager', 'admin'] },
  // Manager + admin only.
  { href: '/dashboard/team', label: 'Team', icon: UserCog, requirePersona: ['manager', 'admin'] },
  // Manager + admin only.
  { href: '/dashboard/activity', label: 'Activity', icon: Activity, requirePersona: ['manager', 'admin'] },
  // Admin only — workflow internals.
  { href: '/dashboard/workflows', label: 'Workflows', icon: Workflow, requirePersona: ['admin'] },
  // Admin only — mail infrastructure visibility.
  { href: '/dashboard/ops', label: 'Mail Ops', icon: Gauge, requirePersona: ['admin'] },
  // Admin only — org-wide settings.
  { href: '/dashboard/settings', label: 'Settings', icon: SettingsIcon, requirePersona: ['admin'] },
  // Admin only.
  {
    href: '/dashboard/recently-deleted',
    label: 'Recently deleted',
    icon: Trash2,
    requirePersona: ['admin'],
  },
];

/**
 * Filter NAV_ITEMS for a given persona. Items without
 * `requirePersona` are visible to everyone; items with it are gated.
 *
 * No fallback to "everything" — an unknown persona gets only the
 * unrestricted items. That eliminates the back-compat leak that
 * showed admin nav to non-admin users when persona resolution
 * failed.
 */
export function navItemsForPersona(
  persona: Persona,
): readonly NavItem[] {
  return NAV_ITEMS.filter(
    (item) => !item.requirePersona || item.requirePersona.includes(persona),
  );
}

/**
 * Active when the path matches the item exactly, or descends from it.
 * `/dashboard` is treated as exact-match so it doesn't light up on
 * `/dashboard/companies`.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}
