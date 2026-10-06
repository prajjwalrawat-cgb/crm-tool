import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Banknote,
  Boxes,
  Brain,
  Briefcase,
  Building2,
  CheckSquare,
  Cog,
  FileText,
  Gauge,
  GitBranch,
  Inbox,
  LayoutDashboard,
  LineChart,
  Radar,
  Settings as SettingsIcon,
  Sparkles,
  Target,
  Trash2,
  UserCog,
  UsersRound,
  HandCoins,
  Wallet,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import type { Persona } from '@/lib/personas';

/**
 * Persona-specific sidebar trees. Earlier iterations used one
 * canonical NAV_GROUPS with per-item persona filtering — that
 * conflated "this item is hidden for some personas" with "this
 * persona has a different information architecture". Admins,
 * managers, and members organize their work around different
 * nouns, so they get different trees.
 *
 * Each tree references existing routes only — no /dashboard/me
 * or /dashboard/forecast inventions. "Forecast" for managers
 * points at the revenue-forecast report; "Personal Settings"
 * points at /dashboard/settings/profile (which has no admin
 * guard, so members and managers can edit it).
 *
 * Route-level enforcement still lives in `requirePersonas()` —
 * the sidebar trees just decide what to *show*.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Match function for "is this nav item highlighted right now?" */
  matcher?: (pathname: string) => boolean;
};

export type NavGroup = {
  id: string;
  label: string;
  items: readonly NavItem[];
};

/* ============================================================ */
/* Per-persona trees                                             */
/* ============================================================ */

const ADMIN_NAV: readonly NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/dashboard/executive', label: 'Executive', icon: Sparkles },
      { href: '/dashboard/executive/forecast', label: 'Forecast', icon: LineChart },
      { href: '/dashboard/team', label: 'Team', icon: UserCog },
      { href: '/dashboard/activity', label: 'Activity', icon: Activity },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    items: [
      { href: '/dashboard/deals/board', label: 'Pipeline', icon: GitBranch },
      { href: '/dashboard/deals', label: 'Deals', icon: Briefcase },
      { href: '/dashboard/deals/approvals', label: 'Approvals', icon: BadgeCheck },
      {
        href: '/dashboard/deals/at-risk',
        label: 'At Risk',
        icon: AlertTriangle,
      },
      { href: '/dashboard/targets', label: 'Targets', icon: Target },
      { href: '/dashboard/incentives', label: 'Incentives', icon: Wallet },
      { href: '/dashboard/collections', label: 'Collections', icon: HandCoins },
      {
        href: '/dashboard/team-performance',
        label: 'Team Performance',
        icon: LineChart,
      },
      { href: '/dashboard/communications', label: 'Communications', icon: Inbox },
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    id: 'crm',
    label: 'CRM',
    items: [
      { href: '/dashboard/contacts', label: 'Contacts', icon: UsersRound },
      { href: '/dashboard/companies', label: 'Companies', icon: Building2 },
      { href: '/dashboard/invoices', label: 'Invoices', icon: FileText },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    items: [
      { href: '/dashboard/command-center', label: 'Command Center', icon: Radar },
      { href: '/dashboard/intelligence', label: 'Intelligence', icon: Brain },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { href: '/dashboard/workflows', label: 'Workflows', icon: Workflow },
      { href: '/dashboard/ops', label: 'Operations', icon: Gauge },
      { href: '/dashboard/settings', label: 'Settings', icon: SettingsIcon },
      { href: '/dashboard/recently-deleted', label: 'Recently deleted', icon: Trash2 },
    ],
  },
];

const MANAGER_NAV: readonly NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/dashboard/executive/forecast', label: 'Forecast', icon: LineChart },
      // The scorecard, not the leaderboard report: pushbacks, quarterly
      // progression, engagement and data completeness per rep. The
      // rep-performance report it used to point at is still one click
      // away under Reports.
      {
        href: '/dashboard/team-performance',
        label: 'Team Performance',
        icon: LineChart,
      },
      { href: '/dashboard/activity', label: 'Activity', icon: Activity },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    items: [
      { href: '/dashboard/deals/board', label: 'Pipeline', icon: GitBranch },
      { href: '/dashboard/deals', label: 'Deals', icon: Briefcase },
      { href: '/dashboard/deals/approvals', label: 'Approvals', icon: BadgeCheck },
      {
        href: '/dashboard/deals/at-risk',
        label: 'At Risk',
        icon: AlertTriangle,
      },
      { href: '/dashboard/targets', label: 'Targets', icon: Target },
      { href: '/dashboard/incentives', label: 'Incentives', icon: Wallet },
      { href: '/dashboard/collections', label: 'Collections', icon: HandCoins },
      // Managers often carry a plan of their own.
      { href: '/dashboard/my-incentive', label: 'My Incentive', icon: Wallet },
      { href: '/dashboard/communications', label: 'Communications', icon: Inbox },
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    id: 'crm',
    label: 'CRM',
    items: [
      { href: '/dashboard/contacts', label: 'Contacts', icon: UsersRound },
      { href: '/dashboard/companies', label: 'Companies', icon: Building2 },
      { href: '/dashboard/invoices', label: 'Invoices', icon: FileText },
    ],
  },
  {
    id: 'management',
    label: 'Management',
    items: [
      { href: '/dashboard/team', label: 'Team', icon: UserCog },
      // Settings entry redirects to /dashboard/settings/profile. The
      // settings sidebar inside that surface shows manager-allowed
      // sections (organization/pipeline/currency) plus the personal
      // sections — AI + email infra stay admin-only.
      { href: '/dashboard/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

const MEMBER_NAV: readonly NavGroup[] = [
  {
    id: 'my-work',
    label: 'My Work',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/dashboard/deals', label: 'My Deals', icon: Briefcase },
      { href: '/dashboard/deals/board', label: 'Pipeline', icon: GitBranch },
      {
        href: '/dashboard/deals/at-risk',
        label: 'At Risk',
        icon: AlertTriangle,
      },
      { href: '/dashboard/tasks', label: 'Tasks', icon: CheckSquare },
      // Communications removed for members — inbox is tenant-shared
      // in the current schema, so member access leaks other reps'
      // threads. Re-add when per-user inbox scoping ships.
    ],
  },
  {
    id: 'crm',
    label: 'CRM',
    items: [
      { href: '/dashboard/contacts', label: 'Contacts', icon: UsersRound },
      { href: '/dashboard/companies', label: 'Companies', icon: Building2 },
      { href: '/dashboard/invoices', label: 'Invoices', icon: FileText },
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    items: [
      // Dedicated Performance Center surface — separate from /dashboard
      // (execution focus) so members can browse longer-running trends
      // without losing their task list. Lives at /dashboard/my-performance.
      {
        href: '/dashboard/my-performance',
        label: 'My Performance',
        icon: Target,
      },
      { href: '/dashboard/targets', label: 'My Targets', icon: Gauge },
      { href: '/dashboard/my-incentive', label: 'My Incentive', icon: Wallet },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      {
        href: '/dashboard/settings/profile',
        label: 'Personal Settings',
        icon: Cog,
      },
    ],
  },
];

/* ============================================================ */
/* Public surface                                                */
/* ============================================================ */

// Owner-only group, appended to whatever persona tree the user has.
const OWNER_GROUP: NavGroup = {
  id: 'owner',
  label: 'Owner',
  items: [
    { href: '/dashboard/organizations', label: 'Organizations', icon: Boxes },
    { href: '/dashboard/invoice-settings', label: 'Invoice settings', icon: Banknote },
  ],
};

export function navGroupsForPersona(
  persona: Persona,
  isOwner = false,
): readonly NavGroup[] {
  const base =
    persona === 'admin'
      ? ADMIN_NAV
      : persona === 'manager'
        ? MANAGER_NAV
        : MEMBER_NAV;
  return isOwner ? [...base, OWNER_GROUP] : base;
}

/**
 * Flat list of every nav item across all personas (de-duplicated).
 * Used by code paths that need a global menu — e.g. the command
 * palette searching every routable label. Each item still has to be
 * gated by `requirePersonas()` at the page level.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  ...new Map(
    [ADMIN_NAV, MANAGER_NAV, MEMBER_NAV]
      .flat()
      .flatMap((g) => g.items)
      .map((i) => [i.href, i] as const),
  ).values(),
];

export function navItemsForPersona(persona: Persona): readonly NavItem[] {
  return navGroupsForPersona(persona).flatMap((g) => g.items);
}

/**
 * Active when the path matches the item exactly, or descends from it.
 * `/dashboard` is exact-match so it doesn't light up on sub-routes;
 * `/dashboard/deals/board` is also exact-match so it doesn't steal
 * highlight from `/dashboard/deals`.
 *
 * The two specific report paths (revenue-forecast, rep-performance)
 * are exact-match too so they don't claim "Reports" highlight at the
 * same time, and `/dashboard/deals/at-risk` is excluded from the Deals
 * prefix match for the same reason the board is.
 */
const EXACT_MATCH_HREFS = new Set([
  '/dashboard',
  // Executive is a prefix of /executive/forecast — exact-match so Forecast
  // doesn't light up both nav rows.
  '/dashboard/executive',
  '/dashboard/deals/board',
  '/dashboard/deals/at-risk',
  '/dashboard/my-performance',
  '/dashboard/reports/revenue-forecast',
  '/dashboard/reports/rep-performance',
  '/dashboard/settings/profile',
]);

export function isNavActive(href: string, pathname: string): boolean {
  if (EXACT_MATCH_HREFS.has(href)) {
    return pathname === href;
  }
  if (href === '/dashboard/deals') {
    return (
      pathname === '/dashboard/deals' ||
      (pathname.startsWith('/dashboard/deals/') &&
        pathname !== '/dashboard/deals/board' &&
        pathname !== '/dashboard/deals/at-risk')
    );
  }
  if (href === '/dashboard/reports') {
    return (
      pathname === '/dashboard/reports' ||
      (pathname.startsWith('/dashboard/reports/') &&
        pathname !== '/dashboard/reports/revenue-forecast' &&
        pathname !== '/dashboard/reports/rep-performance')
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
