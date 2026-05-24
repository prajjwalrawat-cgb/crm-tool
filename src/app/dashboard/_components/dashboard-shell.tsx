'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { Notification } from '@/db/schema';
import type { AIMode } from '@/lib/ai/config';
import type { Persona } from '@/lib/personas';

import { CommandPalette } from './command-palette';
import { CopilotPanel } from './copilot-panel';
import { EditModeProvider } from './edit-mode/edit-mode-context';
import {
  EditModeGridOverlay,
  EditModeIndicator,
} from './edit-mode/edit-mode-indicator';
import { Header } from './header';
import { Sidebar } from './sidebar';

const SIDEBAR_COLLAPSED_KEY = 'crm.sidebar.collapsed';

export function DashboardShell({
  children,
  tenantId,
  currentUserId,
  initialNotifications,
  aiMode,
  persona,
}: {
  children: ReactNode;
  tenantId: string;
  currentUserId: string;
  initialNotifications: Notification[];
  aiMode: AIMode;
  persona: Persona;
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
    // Pin the chrome (sidebar + header) and scroll content separately.
    // Outer is exactly the viewport (h-screen + overflow-hidden); the
    // sidebar takes its natural width and full height (no scroll on
    // page itself); the right column flexes to fill, with the content
    // div being the lone scroll container. This matches the layout
    // pattern in Linear / HubSpot / Attio / Notion.
    //
    // h-screen = 100vh, fine for desktop. On mobile the sidebar is a
    // fixed-position drawer (Sidebar component handles that), so the
    // viewport math doesn't affect the small-screen flow.
    <EditModeProvider>
      <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-black">
        <Sidebar
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebarCollapsed}
          persona={persona}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            onMobileMenuOpen={() => setMobileOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            tenantId={tenantId}
            currentUserId={currentUserId}
            initialNotifications={initialNotifications}
          />
          {/*
            Tenant-scoped invalidation boundary. When the active tenant
            changes (Clerk org switcher → layout re-render → this prop
            updates), React unmounts everything inside this div and
            remounts fresh — every client component below is keyed by
            the tenant they were mounted under.

            `overflow-y-auto` makes THIS the scroll container — the
            sidebar and header stay pinned while the page content scrolls.

            Inner `relative` wrapper hosts the edit-mode dotted grid
            overlay (z-index 0) under the page content so the layout
            canvas feel surfaces when Cmd/Ctrl+Shift+E is active.
          */}
          <div key={tenantId} className="flex-1 overflow-y-auto">
            <div className="relative min-h-full">
              <EditModeGridOverlay />
              <div className="relative z-10">{children}</div>
            </div>
          </div>
        </div>
        <CopilotPanel key={tenantId} aiMode={aiMode} />
        <CommandPalette
          tenantId={tenantId}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
        />
        <EditModeIndicator />
      </div>
    </EditModeProvider>
  );
}
