import {
  Activity,
  Briefcase,
  Building2,
  CheckSquare,
  Gauge,
  LayoutDashboard,
  Mail,
  Trash2,
  UserCog,
  UsersRound,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Render as muted, non-clickable when the destination isn't built yet. */
  comingSoon?: boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/companies', label: 'Companies', icon: Building2 },
  { href: '/dashboard/contacts', label: 'Contacts', icon: UsersRound },
  { href: '/dashboard/deals', label: 'Deals', icon: Briefcase },
  { href: '/dashboard/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/dashboard/email', label: 'Email', icon: Mail },
  { href: '/dashboard/team', label: 'Team', icon: UserCog },
  { href: '/dashboard/activity', label: 'Activity', icon: Activity },
  { href: '/dashboard/workflows', label: 'Workflows', icon: Workflow },
  { href: '/dashboard/ops', label: 'Operations', icon: Gauge },
  {
    href: '/dashboard/recently-deleted',
    label: 'Recently deleted',
    icon: Trash2,
  },
];

/**
 * Active when the path matches the item exactly, or descends from it.
 * `/dashboard` is treated as exact-match so it doesn't light up on
 * `/dashboard/companies`.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}
