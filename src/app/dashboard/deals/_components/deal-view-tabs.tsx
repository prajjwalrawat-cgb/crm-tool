'use client';

import { KanbanSquare, List } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

const TABS = [
  { href: '/dashboard/deals', label: 'List', icon: List, exact: true },
  { href: '/dashboard/deals/board', label: 'Board', icon: KanbanSquare },
];

export function DealViewTabs() {
  const pathname = usePathname();

  return (
    <nav
      role="tablist"
      aria-label="Deals view"
      className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-1 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 transition',
              active
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
