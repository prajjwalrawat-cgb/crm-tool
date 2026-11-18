'use client';

import { createContext, useContext } from 'react';

/** Counts for sidebar badges, keyed by NavItem.badge. Provided by DashboardShell. */
export type NavBadges = Partial<Record<'suggestions', number>>;

export const NavBadgesContext = createContext<NavBadges>({});

export function useNavBadge(key: keyof NavBadges | undefined): number {
  const badges = useContext(NavBadgesContext);
  return key ? (badges[key] ?? 0) : 0;
}
