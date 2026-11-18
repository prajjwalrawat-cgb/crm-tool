'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import type { MetricUnit } from '@/lib/reports/metrics';
import { fmt, type CurrencyCtx } from '@/lib/reports/manager/format';
import type { RepRow } from '@/lib/reports/manager/services';
import { cn } from '@/lib/utils';

import { EmptyState, VIZ } from './ui';

const COLS: Array<{ key: keyof RepRow; label: string; unit: MetricUnit }> = [
  { key: 'calls', label: 'Calls', unit: 'count' },
  { key: 'contactRatePct', label: 'Connect rate', unit: 'percent' },
  { key: 'talkTimeMin', label: 'Talk time', unit: 'minutes' },
  { key: 'activitiesPerDay', label: 'Activities / day', unit: 'decimal' },
  { key: 'qualified', label: 'Qualified', unit: 'count' },
  { key: 'won', label: 'Won', unit: 'count' },
  { key: 'wonValue', label: 'Won value', unit: 'currency' },
  { key: 'slaPct', label: 'SLA met', unit: 'percent' },
  { key: 'firstResponseMin', label: 'First response', unit: 'minutes' },
];

// Band vs team median: blue = better, orange = worse (diverging pair), plus
// ▲/▼ glyph and screen-reader text so colour is never the only cue.
const BAND_BG: Record<number, string> = {
  2: 'bg-[color-mix(in_oklab,var(--viz-1)_24%,transparent)]',
  1: 'bg-[color-mix(in_oklab,var(--viz-1)_11%,transparent)]',
  0: '',
  [-1]: 'bg-[color-mix(in_oklab,var(--viz-2)_11%,transparent)]',
  [-2]: 'bg-[color-mix(in_oklab,var(--viz-2)_24%,transparent)]',
};

export function RepTable({ rows, medians, currency, query }: { rows: RepRow[]; medians: Record<string, number | null>; currency: CurrencyCtx; query: Record<string, string> }) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: keyof RepRow; dir: 1 | -1 }>({ key: 'wonValue', dir: -1 });
  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[sort.key] as number | string | null;
      const bv = b[sort.key] as number | string | null;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir;
    });
    return out;
  }, [rows, sort]);
  if (rows.length === 0) return <EmptyState title="No reps in your scope" body="Set up reporting lines under Settings › Reporting lines." />;
  const qs = new URLSearchParams(query).toString();

  return (
    <div className={cn('max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white', VIZ)}>
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <SortTh label="Rep" active={sort.key === 'name'} dir={sort.dir} onClick={() => setSort((s) => ({ key: 'name', dir: s.key === 'name' ? (-s.dir as 1 | -1) : 1 }))} align="left" />
            {COLS.map((c) => (
              <SortTh key={c.key} label={c.label} active={sort.key === c.key} dir={sort.dir} onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : -1 }))} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.userId} onClick={() => router.push(`/dashboard/insights/reps/${encodeURIComponent(r.userId)}?${qs}`)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2 font-medium text-slate-900">{r.name}</td>
              {COLS.map((c) => {
                const band = r.bands[c.key as string] ?? 0;
                return (
                  <td key={c.key} className={cn('px-3 py-2 text-right tabular-nums text-slate-800', BAND_BG[band])}>
                    {fmt(c.unit, r[c.key] as number | null, currency, c.unit === 'currency')}
                    {band !== 0 && (
                      <span className="ml-1 text-[10px] text-slate-500" aria-hidden>
                        {band > 0 ? '▲' : '▼'}
                      </span>
                    )}
                    {band !== 0 && <span className="sr-only">{band > 0 ? ' above team median' : ' below team median'}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-slate-200 bg-slate-50 text-[11.5px] text-slate-500">
          <tr>
            <td className="px-3 py-2">Team median</td>
            {COLS.map((c) => (
              <td key={c.key} className="px-3 py-2 text-right tabular-nums">
                {fmt(c.unit, medians[c.key as string] ?? null, currency, c.unit === 'currency')}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">Shading compares each rep with the team median: ▲ blue is better, ▼ orange is worse. Click a row for that rep.</p>
    </div>
  );
}

function SortTh({ label, active, dir, onClick, align = 'right' }: { label: string; active: boolean; dir: 1 | -1; onClick: () => void; align?: 'left' | 'right' }) {
  return (
    <th className={cn('px-3 py-2 font-medium', align === 'right' ? 'text-right' : 'text-left')} aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={onClick} className="inline-flex items-center gap-1 uppercase hover:text-slate-800">
        {label}
        {active && <span aria-hidden>{dir === 1 ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
}
