'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const select =
  'rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]';

/** Fiscal year, period and SPOC — all in the URL, so a view can be shared. */
export function CollectionsFilters({
  fiscalYear,
  fyChoices,
  period,
  spoc,
  spocChoices,
}: {
  fiscalYear: number;
  fyChoices: { value: number; label: string }[];
  period: string;
  spoc: string;
  spocChoices: { value: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Fiscal year" value={fiscalYear} onChange={(e) => set('fy', e.target.value)} className={select}>
        {fyChoices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
      <select aria-label="Period" value={period} onChange={(e) => set('period', e.target.value)} className={select}>
        <option value="fy">Full year</option>
        <option value="q1">Q1</option>
        <option value="q2">Q2</option>
        <option value="q3">Q3</option>
        <option value="q4">Q4</option>
      </select>
      <select aria-label="SPOC" value={spoc} onChange={(e) => set('spoc', e.target.value)} className={select}>
        <option value="">All SPOCs</option>
        {spocChoices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}
