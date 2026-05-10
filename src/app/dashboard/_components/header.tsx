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
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur sm:px-6 dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onMobileMenuOpen}
          aria-label="Open navigation"
          className="rounded-md p-2 text-zinc-600 hover:bg-zinc-100 md:hidden dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <PresenceIndicator tenantId={tenantId} />
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
