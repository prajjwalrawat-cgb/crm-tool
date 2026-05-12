'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { AIMode } from '@/lib/ai/config';

import { CommandPalette } from './command-palette';
import { CopilotPanel } from './copilot-panel';
import { Header } from './header';
import { Sidebar } from './sidebar';

const SIDEBAR_COLLAPSED_KEY = 'crm.sidebar.collapsed';

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar collapsed default is false; localStorage hydrates it after
  // first paint to avoid SSR/CSR mismatch flicker.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const pathname = usePathname();

  // Global Cmd/Ctrl+K → toggle the command palette. Captured at the
  // window level so the shortcut works regardless of focus (input,
  // table cell, button). Skip when inside a content-editable to avoid
  // hijacking inline editing UIs that might also use ⌘K.
  const onPaletteShortcut = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'k' && e.key !== 'K') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = e.target as HTMLElement | null;
    if (target?.isContentEditable) return;
    e.preventDefault();
    setPaletteOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onPaletteShortcut);
    return () => window.removeEventListener('keydown', onPaletteShortcut);
  }, [onPaletteShortcut]);

  // Close palette on route change.
  useEffect(() => {
    setPaletteOpen(false);
  }, [pathname]);

  // Hydrate sidebar collapsed preference from localStorage once on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (raw === '1') setSidebarCollapsed(true);
    } catch {
      // Storage not available (private mode, sandbox); ignore.
    }
  }, []);

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* storage may be unavailable */
      }
      return next;
    });
  }

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          onMobileMenuOpen={() => setMobileOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          tenantId={tenantId}
        />
        {/*
          Tenant-scoped invalidation boundary. When the active tenant
          changes (Clerk org switcher → layout re-render → this prop
          updates), React unmounts everything inside this div and
          remounts fresh. That's the single architectural answer to
          "stale activity rows from the previous tenant survive a
          switch": every client component below is keyed by the tenant
          they were mounted under, so their `useState`/`useOptimistic`
          state is discarded with the old subtree instead of leaking
          across tenants.

          Components that live OUTSIDE this div (Sidebar, Header,
          CopilotPanel) keep their state across tenant switches. Anything
          tenant-scoped at that layer is keyed individually at its render
          site (PresenceIndicator inside Header, CopilotPanel below).
        */}
        <div key={tenantId} className="flex-1">
          {children}
        </div>
      </div>
      <CopilotPanel key={tenantId} aiMode={aiMode} />
      <CommandPalette
        tenantId={tenantId}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
      />
    </div>
  );
}
