import {
  Activity,
  BarChart3,
  Brain,
  Briefcase,
  Building2,
  CalendarDays,
  CheckSquare,
  Gauge,
  Inbox,
  LayoutDashboard,
  LineChart,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  TrendingUp,
  UserCog,
  UsersRound,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import type { Persona } from '@/lib/personas';

/**
 * Persona-aware sidebar nav. Phase 17-A consolidation:
 *
 *   - Sales: 7 items. Action-oriented; no analytics drill-downs.
 *   - Manager: 8 items. Team-and-forecast oriented.
 *   - Admin: 10 items. Infrastructure + operations visibility.
 *
 * Routes the user can access (RBAC-allowed) but that aren't in their
 * sidebar are still reachable via deep-link — the sidebar is curation,
 * not permission.
 *
 * AI is no longer a top-level destination for any persona.
 * `/dashboard/intelligence` still exists as a permalink (back-compat)
 * but doesn't appear in any sidebar. AI surfaces inside the surfaces
 * it describes (deal detail, thread detail, Home).
 */

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  comingSoon?: boolean;
};

const SALES_NAV: readonly NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/dashboard/deals', label: 'Deals', icon: Briefcase },
  { href: '/dashboard/communications', label: 'Communications', icon: Inbox },
  { href: '/dashboard/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/dashboard/contacts', label: 'Contacts', icon: UsersRound },
  { href: '/dashboard/companies', label: 'Companies', icon: Building2 },
  { href: '/dashboard/my-performance', label: 'My performance', icon: TrendingUp, comingSoon: true },
];

const MANAGER_NAV: readonly NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/dashboard/team', label: 'Team', icon: UserCog },
  { href: '/dashboard/deals', label: 'Pipeline', icon: Briefcase },
  { href: '/dashboard/reports/revenue-forecast', label: 'Forecast', icon: LineChart },
  { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
  { href: '/dashboard/communications', label: 'Communications', icon: Inbox },
  { href: '/dashboard/intelligence', label: 'Insights', icon: Sparkles },
  { href: '/dashboard/activity', label: 'Activity', icon: Activity },
];

const ADMIN_NAV: readonly NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/dashboard/executive', label: 'Executive', icon: Sparkles },
  { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
  { href: '/dashboard/communications', label: 'Communications', icon: Inbox },
  { href: '/dashboard/workflows', label: 'Operations', icon: Workflow },
  { href: '/dashboard/ops', label: 'Mail Ops', icon: Gauge },
  { href: '/dashboard/team', label: 'Team', icon: UserCog },
  { href: '/dashboard/activity', label: 'Activity', icon: Activity },
  { href: '/dashboard/settings', label: 'Settings', icon: SettingsIcon },
  { href: '/dashboard/recently-deleted', label: 'Recently deleted', icon: Trash2 },
];

export const SIDEBARS_BY_PERSONA: Record<Persona, readonly NavItem[]> = {
  sales: SALES_NAV,
  manager: MANAGER_NAV,
  admin: ADMIN_NAV,
};

/**
 * Back-compat export. Older imports across the codebase still
 * reference `NAV_ITEMS` directly; default to the admin sidebar so
 * legacy call sites see every route until they migrate to the
 * persona-aware sidebar. Once the migration is complete this can
 * be removed.
 */
export const NAV_ITEMS: readonly NavItem[] = ADMIN_NAV;

/**
 * Active when the path matches the item exactly, or descends from it.
 * `/dashboard` is treated as exact-match so it doesn't light up on
 * `/dashboard/companies`.
 *
 * Sub-routes also light up their parent — `/dashboard/reports/revenue-forecast`
 * shows BOTH the Forecast entry (exact match) and the Reports entry
 * (descendant), so we apply most-specific-wins by length.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Pick the most specific matching nav item for a path. Used by the
 * sidebar so a forecast page lights Forecast (specific) instead of
 * Reports (broader).
 */
export function pickActiveItem(
  items: readonly NavItem[],
  pathname: string,
): NavItem | null {
  let best: NavItem | null = null;
  for (const item of items) {
    if (!isNavActive(item.href, pathname)) continue;
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best;
}
