'use client';

import {
  Bell,
  Building2,
  Mail,
  Palette,
  Sparkles,
  User,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Settings sidebar nav. Each entry maps a sub-route under `/dashboard/settings`
 * to its label and icon. New sections add an entry here and a matching
 * page; nothing else changes.
 */

type SettingsItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Section header (rendered above this item) — optional. */
  group?: string;
  /** Comingsoon — non-clickable, muted. */
  comingSoon?: boolean;
};

const ITEMS: readonly SettingsItem[] = [
  { href: '/dashboard/settings/profile', label: 'Profile', icon: User, group: 'Account' },
  { href: '/dashboard/settings/appearance', label: 'Appearance', icon: Palette },
  { href: '/dashboard/settings/notifications', label: 'Notifications', icon: Bell, comingSoon: true },
  { href: '/dashboard/settings/email', label: 'Email', icon: Mail, group: 'Workspace', comingSoon: true },
  { href: '/dashboard/settings/organization', label: 'Organization', icon: Building2, comingSoon: true },
  { href: '/dashboard/settings/ai', label: 'AI', icon: Sparkles, comingSoon: true },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      {ITEMS.map((item, i) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        const showGroup = item.group && (i === 0 || ITEMS[i - 1].group !== item.group);

        if (item.comingSoon) {
          return (
            <div key={item.href}>
              {showGroup ? (
                <div className="mt-3 mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-[#A1A1AA]">
                  {item.group}
                </div>
              ) : null}
              <span
                aria-disabled
                className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-slate-400 dark:text-[#A1A1AA]"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="flex-1">{item.label}</span>
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-[#181818] dark:text-[#A1A1AA]">
                  Soon
                </span>
              </span>
            </div>
          );
        }

        return (
          <div key={item.href}>
            {showGroup ? (
              <div className="mt-3 mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-[#A1A1AA]">
                {item.group}
              </div>
            ) : null}
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition',
                active
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span>{item.label}</span>
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
