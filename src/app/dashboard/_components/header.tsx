'use client';

import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import { Menu, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { Notification } from '@/db/schema';

import { NotificationBell } from './notification-bell';
import { PresenceIndicator } from './presence-indicator';

type Props = {
  onMobileMenuOpen: () => void;
  onOpenPalette: () => void;
  tenantId: string;
  currentUserId: string;
  initialNotifications: Notification[];
};

export function Header({
  onMobileMenuOpen,
  onOpenPalette,
  tenantId,
  currentUserId,
  initialNotifications,
}: Props) {
  // Render the platform-correct shortcut on first mount only, so the
  // shortcut hint matches the OS the user is actually on without
  // forcing the server-rendered HTML to commit a guess.
  const [shortcut, setShortcut] = useState('⌘K');
  useEffect(() => {
    setShortcut(
      typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
        ? '⌘K'
        : 'Ctrl K',
    );
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b border-slate-200/80 bg-white/85 px-3 backdrop-blur-md sm:px-5">
      <div className="flex flex-1 items-center gap-2">
        <button
          type="button"
          onClick={onMobileMenuOpen}
          aria-label="Open navigation"
          className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 md:hidden"
        >
          <Menu className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label={`Open command palette (${shortcut})`}
          title={`Search and jump — ${shortcut}`}
          className="group inline-flex h-7 max-w-sm flex-1 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 sm:max-w-md"
        >
          <Search className="h-3.5 w-3.5 text-slate-400 group-hover:text-slate-500" aria-hidden />
          <span className="flex-1 text-left">Search deals, companies, contacts…</span>
          <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1 py-0 text-[10px] font-medium text-slate-500 sm:inline">
            {shortcut}
          </kbd>
        </button>
      </div>

      <div className="flex items-center gap-3">
        {/*
          Keyed by tenantId so the avatar list resets immediately when
          the active org changes — otherwise members from the previous
          tenant flash on screen until the next SSE `presence.snapshot`
          arrives. This component lives in the Header (outside the
          shell's tenant-scoped children div) so it needs its own key.
        */}
        <NotificationBell
          key={`${tenantId}:${currentUserId}`}
          tenantId={tenantId}
          currentUserId={currentUserId}
          initialNotifications={initialNotifications}
        />
        <PresenceIndicator key={tenantId} tenantId={tenantId} />
        <OrganizationSwitcher
          hidePersonal
          afterCreateOrganizationUrl="/dashboard"
          afterSelectOrganizationUrl="/dashboard"
          afterLeaveOrganizationUrl="/select-org"
        />
        <UserButton />
      </div>
    </header>
  );
}
