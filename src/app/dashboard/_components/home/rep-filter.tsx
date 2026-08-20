'use client';

import { Users } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import { viewScopeParam, type ViewScope } from '@/lib/dashboard/view-scope';

/**
 * Team-vs-rep filter for the manager/admin dashboard. Changing it navigates to
 * `?view=team` or `?view=rep:<userId>` — the same URL contract the home pages
 * read server-side, so the whole dashboard rescopes to the chosen person.
 *
 * Other params (notably `range`/`from`/`to`) are carried through, so
 * switching rep keeps the selected time window.
 *
 * `basePath` exists because the Executive dashboard mounts this same
 * picker; hardcoding `/dashboard` would have navigated its users off
 * the page they were filtering.
 */
export function RepFilter({
  teammates,
  value,
  basePath = '/dashboard',
}: {
  teammates: Array<{ id: string; displayName: string }>;
  value: ViewScope;
  /** Route to navigate within. Must be the page rendering this. */
  basePath?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const current = value.mode === 'rep' ? value.userId : 'team';

  return (
    <label className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
      <Users className="h-3.5 w-3.5 text-slate-400" aria-hidden />
      <span className="text-slate-500 dark:text-[#A1A1AA]">Viewing</span>
      <select
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          const next = new URLSearchParams(params?.toString() ?? '');
          next.set(
            'view',
            viewScopeParam(
              v === 'team' ? { mode: 'team' } : { mode: 'rep', userId: v },
            ),
          );
          router.push(`${basePath}?${next.toString()}`);
        }}
        className="cursor-pointer bg-transparent pr-1 text-[12px] font-semibold text-slate-800 focus:outline-none dark:text-[#FAFAFA]"
      >
        <option value="team">Whole team</option>
        {teammates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
