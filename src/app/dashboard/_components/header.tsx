'use client';

import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import { Menu } from 'lucide-react';

import { PresenceIndicator } from './presence-indicator';

type Props = {
  onMobileMenuOpen: () => void;
  tenantId: string;
};

export function Header({ onMobileMenuOpen, tenantId }: Props) {
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b border-slate-200/80 bg-white/85 px-3 backdrop-blur-md sm:px-5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onMobileMenuOpen}
          aria-label="Open navigation"
          className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 md:hidden"
        >
          <Menu className="h-4 w-4" aria-hidden />
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
