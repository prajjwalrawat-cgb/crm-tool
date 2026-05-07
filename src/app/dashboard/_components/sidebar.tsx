'use client';

import { Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

import { isNavActive, NAV_ITEMS } from './nav-config';

type Props = {
  mobileOpen: boolean;
  onMobileClose: () => void;
};

export function Sidebar({ mobileOpen, onMobileClose }: Props) {
  return (
    <>
      <DesktopSidebar />
      <MobileSidebar open={mobileOpen} onClose={onMobileClose} />
    </>
  );
}

function DesktopSidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white md:flex md:flex-col dark:border-zinc-800 dark:bg-zinc-950">
      <Brand />
      <NavList pathname={pathname} />
      <Footer />
    </aside>
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
      {/* Backdrop */}
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
      {/* Drawer */}
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
        <Footer />
      </aside>
    </div>
  );
}

function Brand({ inline = false }: { inline?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2',
        inline ? 'pb-2' : 'border-b border-zinc-200 px-5 py-4 dark:border-zinc-800',
      )}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900">
        <Sparkles className="h-4 w-4" aria-hidden />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight">CRM</div>
        <div className="text-xs text-zinc-500">multi-tenant</div>
      </div>
    </div>
  );
}

function NavList({
  pathname,
  onLinkClick,
}: {
  pathname: string;
  onLinkClick?: () => void;
}) {
  return (
    <nav className="flex-1 px-3 py-4">
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item.href, pathname);
          const Icon = item.icon;

          if (item.comingSoon) {
            return (
              <li key={item.href}>
                <span
                  aria-disabled
                  className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-zinc-400 dark:text-zinc-600"
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500">
                    Soon
                  </span>
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
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition',
                  active
                    ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Footer() {
  return (
    <div className="border-t border-zinc-200 px-5 py-4 text-[11px] text-zinc-500 dark:border-zinc-800">
      Built on Next.js 16
    </div>
  );
}
