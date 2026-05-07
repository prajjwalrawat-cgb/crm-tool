import {
  Briefcase,
  Building2,
  LayoutDashboard,
  UsersRound,
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
