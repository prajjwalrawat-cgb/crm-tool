'use client';

import { ChevronsLeft, ChevronsRight, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

import { isNavActive, NAV_ITEMS } from './nav-config';

type Props = {
  mobileOpen: boolean;
  onMobileClose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export function Sidebar({
  mobileOpen,
  onMobileClose,
  collapsed,
  onToggleCollapsed,
}: Props) {
  return (
    <>
      <DesktopSidebar collapsed={collapsed} onToggle={onToggleCollapsed} />
      <MobileSidebar open={mobileOpen} onClose={onMobileClose} />
    </>
  );
}

function DesktopSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-200 ease-out md:flex',
        collapsed ? 'w-14' : 'w-[12.5rem]',
      )}
    >
      <Brand collapsed={collapsed} />
      <NavList pathname={pathname} collapsed={collapsed} />
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
    <div className="border-t border-slate-200">
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-[11px] text-slate-500 transition hover:bg-slate-50 hover:text-slate-900',
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
}: {
  open: boolean;
  onClose: () => void;
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
          'absolute inset-y-0 left-0 flex w-72 flex-col border-r border-slate-200 bg-white shadow-xl transition-transform',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <Brand inline />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <NavList pathname={pathname} onLinkClick={onClose} />
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
    <div
      className={cn(
        'flex items-center gap-2',
        inline
          ? 'pb-2'
          : 'border-b border-slate-200 px-3 py-3',
        collapsed && !inline && 'justify-center px-0',
      )}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-sm">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
      </div>
      {!collapsed ? (
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight">CRM</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">multi-tenant</div>
        </div>
      ) : null}
    </div>
  );
}

function NavList({
  pathname,
  collapsed = false,
  onLinkClick,
}: {
  pathname: string;
  collapsed?: boolean;
  onLinkClick?: () => void;
}) {
  return (
    <nav className={cn('flex-1 py-2', collapsed ? 'px-1.5' : 'px-2')}>
      <ul className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item.href, pathname);
          const Icon = item.icon;

          if (item.comingSoon) {
            return (
              <li key={item.href}>
                <span
                  aria-disabled
                  title={collapsed ? `${item.label} (soon)` : undefined}
                  className={cn(
                    'flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-slate-400',
                    collapsed && 'justify-center px-2',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {!collapsed ? (
                    <>
                      <span className="flex-1">{item.label}</span>
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        Soon
                      </span>
                    </>
                  ) : null}
                </span>
              </li>
            );
          }

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onLinkClick}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={cn(
                  // Linear/Attio-style nav: subtle tinted surface for
                  // active, calm hover for idle. No more solid-black
                  // pill — that read as "developer console" rather
                  // than "SaaS product".
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition',
                  active
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  collapsed && 'justify-center px-2',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {!collapsed ? <span>{item.label}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
