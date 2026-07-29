'use client';

import { ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { SaleinxIcon, SaleinxWordmark } from '@/lib/brand/logo';
import type { Persona } from '@/lib/personas';
import { cn } from '@/lib/utils';

import { HoverPrefetchLink } from './hover-prefetch-link';
import { isNavActive, navGroupsForPersona } from './nav-config';

type Props = {
  mobileOpen: boolean;
  onMobileClose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  persona: Persona;
  isOwner: boolean;
};

export function Sidebar({
  mobileOpen,
  onMobileClose,
  collapsed,
  onToggleCollapsed,
  persona,
  isOwner,
}: Props) {
  return (
    <>
      <DesktopSidebar
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
        persona={persona}
        isOwner={isOwner}
      />
      <MobileSidebar
        open={mobileOpen}
        onClose={onMobileClose}
        persona={persona}
        isOwner={isOwner}
      />
    </>
  );
}

function DesktopSidebar({
  collapsed,
  onToggle,
  persona,
  isOwner,
}: {
  collapsed: boolean;
  onToggle: () => void;
  persona: Persona;
  isOwner: boolean;
}) {
  const pathname = usePathname();
  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-200 ease-out md:flex dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        collapsed ? 'w-14' : 'w-[12.5rem]',
      )}
    >
      <Brand collapsed={collapsed} />
      <NavList pathname={pathname} collapsed={collapsed} persona={persona} isOwner={isOwner} />
      <CollapseToggle collapsed={collapsed} onToggle={onToggle} />
    </aside>
  );
}

function CollapseToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-t border-slate-200 dark:border-[#1F1F1F]">
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-[11px] text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
          collapsed && 'justify-center px-0',
        )}
      >
        {collapsed ? (
          <ChevronsRight className="h-4 w-4" aria-hidden />
        ) : (
          <>
            <ChevronsLeft className="h-4 w-4" aria-hidden />
            <span>Collapse</span>
          </>
        )}
      </button>
    </div>
  );
}

function MobileSidebar({
  open,
  onClose,
  persona,
  isOwner,
}: {
  open: boolean;
  onClose: () => void;
  persona: Persona;
  isOwner: boolean;
}) {
  const pathname = usePathname();

  return (
    <div
      className={cn(
        'fixed inset-0 z-40 md:hidden',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        className={cn(
          'absolute inset-0 bg-black/50 transition-opacity',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        className={cn(
          'absolute inset-y-0 left-0 flex w-72 flex-col border-r border-slate-200 bg-white shadow-xl transition-transform dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <Brand inline />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-slate-800/60"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <NavList pathname={pathname} onLinkClick={onClose} persona={persona} isOwner={isOwner} />
      </aside>
    </div>
  );
}

function Brand({
  inline = false,
  collapsed = false,
}: {
  inline?: boolean;
  collapsed?: boolean;
}) {
  return (
    <Link
      href="/dashboard"
      aria-label="Saleinx — go to dashboard"
      className={cn(
        'flex items-center gap-2 transition hover:opacity-90',
        inline
          ? 'pb-2'
          : 'border-b border-slate-200 px-3 py-3 dark:border-[#1F1F1F]',
        collapsed && !inline && 'justify-center px-0',
      )}
    >
      <SaleinxIcon size={22} className="shrink-0" />
      {!collapsed ? <SaleinxWordmark size="md" /> : null}
    </Link>
  );
}

function NavList({
  pathname,
  collapsed = false,
  onLinkClick,
  persona,
  isOwner,
}: {
  pathname: string;
  collapsed?: boolean;
  onLinkClick?: () => void;
  persona: Persona;
  isOwner: boolean;
}) {
  const groups = navGroupsForPersona(persona, isOwner);
  return (
    <nav
      // `min-h-0` is what makes `overflow-y-auto` actually scroll inside
      // a flex column: without it, flex children default to
      // `min-height: auto` and won't shrink below their content size,
      // which pushes the CollapseToggle off-screen when the nav list
      // exceeds the available height.
      className={cn(
        'min-h-0 flex-1 overflow-y-auto py-2',
        collapsed ? 'px-1.5' : 'px-2',
      )}
    >
      <div className="flex flex-col gap-3">
        {groups.map((group, idx) => (
          <div key={group.id} className="flex flex-col gap-0.5">
            {!collapsed ? (
              <h3 className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:text-[#71717A]">
                {group.label}
              </h3>
            ) : idx > 0 ? (
              <div
                className="mx-2 mb-0.5 border-t border-slate-200/70 dark:border-[#1F1F1F]"
                aria-hidden
              />
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isNavActive(item.href, pathname);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    {/* Intent-deferred prefetch: 19-23 nav links are in the
                        viewport on every dashboard page, and automatic
                        prefetch (production-only) would fire an `?_rsc=`
                        render for all of them at once. */}
                    <HoverPrefetchLink
                      href={item.href}
                      onClick={onLinkClick}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition',
                        active
                          ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
                        collapsed && 'justify-center px-2',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      {!collapsed ? <span>{item.label}</span> : null}
                    </HoverPrefetchLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
