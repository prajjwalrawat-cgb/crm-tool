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
        'hidden shrink-0 flex-col border-r border-zinc-200 bg-white transition-[width] duration-200 ease-out md:flex dark:border-zinc-800 dark:bg-zinc-950',
        collapsed ? 'w-14' : 'w-60',
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
    <div className="border-t border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-3 text-xs text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100',
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
          'absolute inset-y-0 left-0 flex w-72 flex-col border-r border-zinc-200 bg-white shadow-xl transition-transform dark:border-zinc-800 dark:bg-zinc-950',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <Brand inline />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
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
          : 'border-b border-zinc-200 px-4 py-4 dark:border-zinc-800',
        collapsed && !inline && 'justify-center px-0',
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900">
        <Sparkles className="h-4 w-4" aria-hidden />
      </div>
      {!collapsed ? (
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">CRM</div>
          <div className="text-xs text-zinc-500">multi-tenant</div>
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
    <nav className={cn('flex-1 py-3', collapsed ? 'px-2' : 'px-3')}>
      <ul className="flex flex-col gap-1">
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
                    'flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-zinc-400 dark:text-zinc-600',
                    collapsed && 'justify-center px-2',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {!collapsed ? (
                    <>
                      <span className="flex-1">{item.label}</span>
                      <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500">
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
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition',
                  active
                    ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900',
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
