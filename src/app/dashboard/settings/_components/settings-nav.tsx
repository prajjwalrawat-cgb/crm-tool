'use client';

import {
  Banknote,
  Bell,
  Brain,
  Building2,
  GitBranch,
  ListPlus,
  Mail,
  ShieldCheck,
  Palette,
  Target,
  User,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { Persona } from '@/lib/personas';
import { cn } from '@/lib/utils';

/**
 * Settings sidebar nav. Per-section persona visibility:
 *   - everyone           profile, appearance, notifications
 *   - manager + admin    organization, pipeline, currency
 *   - admin only         email, AI infrastructure
 *
 * Drives BOTH which sections appear in the settings rail and the
 * order they're grouped. Page-level `requirePersonas()` guards are
 * the actual gate — this is curation.
 */

type Visibility = 'all' | 'managerOrAdmin' | 'adminOnly';

type SettingsItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group?: string;
  visibility: Visibility;
};

const ITEMS: readonly SettingsItem[] = [
  { href: '/dashboard/settings/profile', label: 'Profile', icon: User, group: 'Account', visibility: 'all' },
  { href: '/dashboard/settings/appearance', label: 'Appearance', icon: Palette, visibility: 'all' },
  { href: '/dashboard/settings/notifications', label: 'Notifications', icon: Bell, visibility: 'all' },
  { href: '/dashboard/settings/organization', label: 'Organization', icon: Building2, group: 'Workspace', visibility: 'managerOrAdmin' },
  { href: '/dashboard/settings/pipeline', label: 'Pipeline', icon: GitBranch, visibility: 'managerOrAdmin' },
  { href: '/dashboard/settings/currency', label: 'Currency & Locale', icon: Banknote, visibility: 'managerOrAdmin' },
  { href: '/dashboard/settings/targets', label: 'Sales targets', icon: Target, visibility: 'adminOnly' },
  { href: '/dashboard/settings/custom-fields', label: 'Custom fields', icon: ListPlus, visibility: 'adminOnly' },
  { href: '/dashboard/settings/stage-gates', label: 'Stage gates', icon: ShieldCheck, visibility: 'adminOnly' },
  { href: '/dashboard/settings/email', label: 'Email', icon: Mail, group: 'Infrastructure', visibility: 'adminOnly' },
  { href: '/dashboard/settings/ai', label: 'AI', icon: Brain, visibility: 'adminOnly' },
];

function isVisible(v: Visibility, persona: Persona): boolean {
  if (v === 'all') return true;
  if (v === 'managerOrAdmin') return persona === 'manager' || persona === 'admin';
  return persona === 'admin';
}

export function SettingsNav({ persona }: { persona: Persona }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => isVisible(i.visibility, persona));

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      {items.map((item, i) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        const showGroup = item.group && (i === 0 || items[i - 1].group !== item.group);

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
