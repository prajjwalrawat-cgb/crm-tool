'use client';

import {
  Banknote,
  Bell,
  Brain,
  Building2,
  GitBranch,
  Mail,
  Palette,
  User,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Settings sidebar nav. Each entry maps a sub-route under
 * `/dashboard/settings`. Every section here is functional — the
 * "Soon" placeholder pattern from CP#15 is gone.
 */

type SettingsItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Optional group header rendered above this item. */
  group?: string;
};

const ITEMS: readonly SettingsItem[] = [
  { href: '/dashboard/settings/profile', label: 'Profile', icon: User, group: 'Account' },
  { href: '/dashboard/settings/appearance', label: 'Appearance', icon: Palette },
  { href: '/dashboard/settings/notifications', label: 'Notifications', icon: Bell },
  { href: '/dashboard/settings/organization', label: 'Organization', icon: Building2, group: 'Workspace' },
  { href: '/dashboard/settings/email', label: 'Email', icon: Mail },
  { href: '/dashboard/settings/pipeline', label: 'Pipeline', icon: GitBranch },
  { href: '/dashboard/settings/currency', label: 'Currency & Locale', icon: Banknote },
  { href: '/dashboard/settings/ai', label: 'AI', icon: Brain },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      {ITEMS.map((item, i) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        const showGroup = item.group && (i === 0 || ITEMS[i - 1].group !== item.group);

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
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]',
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
