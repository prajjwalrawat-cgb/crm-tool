'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import type { AIMode } from '@/lib/ai/config';

import { CopilotPanel } from './copilot-panel';
import { Header } from './header';
import { Sidebar } from './sidebar';

export function DashboardShell({
  children,
  tenantId,
  aiMode,
}: {
  children: ReactNode;
  tenantId: string;
  aiMode: AIMode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          onMobileMenuOpen={() => setMobileOpen(true)}
          tenantId={tenantId}
        />
        <div className="flex-1">{children}</div>
      </div>
      <CopilotPanel aiMode={aiMode} />
    </div>
  );
}
