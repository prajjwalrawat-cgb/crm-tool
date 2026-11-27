'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { GROUP_BY_KEYS, PROSPECT_STAGES, type GroupByKey, type ProspectFilters } from '@/lib/prospects/rules';

import { STAGE_LABELS } from './prospect-column';

const GROUP_LABELS: Record<GroupByKey, string> = {
  industry: 'industry',
  territory: 'territory',
  product_fit: 'product fit',
  source_tag: 'source',
};

const selectCls = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[13px] text-slate-700';
const chipCls = (on: boolean) =>
  `rounded-md border px-2.5 py-1.5 text-[13px] ${
    on ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
  }`;

type Props = {
  filters: ProspectFilters;
  sourceTags: string[];
  /** False when offerings are off: no "Group by product fit". */
  productFitEnabled: boolean;
  /** Writes the next filter set to the URL query string. */
  onChange: (next: ProspectFilters) => void;
  /** Right-aligned slot (e.g. the New prospect button). */
  actions?: ReactNode;
};

export function BoardToolbar({ filters, sourceTags, productFitEnabled, onChange, actions }: Props) {
  const [q, setQ] = useState(filters.q ?? '');
  const [lastUrlQ, setLastUrlQ] = useState(filters.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the box in sync when the URL changes elsewhere (back/forward).
  if (lastUrlQ !== filters.q) {
    setLastUrlQ(filters.q);
    setQ(filters.q ?? '');
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function onSearch(value: string) {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange({ ...filters, q: value.trim() || undefined }), 300);
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={!!filters.mine}
        className={chipCls(!!filters.mine)}
        onClick={() => onChange({ ...filters, mine: filters.mine ? undefined : true })}
      >
        Mine
      </button>
      <button
        type="button"
        aria-pressed={!!filters.unclaimed}
        className={chipCls(!!filters.unclaimed)}
        onClick={() => onChange({ ...filters, unclaimed: filters.unclaimed ? undefined : true })}
      >
        Unclaimed
      </button>
      <select
        aria-label="Source"
        className={selectCls}
        value={filters.source ?? ''}
        onChange={(e) => onChange({ ...filters, source: e.target.value || undefined })}
      >
        <option value="">All sources</option>
        {sourceTags.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select
        aria-label="Stage"
        className={selectCls}
        value={filters.stage ?? ''}
        onChange={(e) => onChange({ ...filters, stage: (e.target.value || undefined) as ProspectFilters['stage'] })}
      >
        <option value="">All stages</option>
        {PROSPECT_STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      <select
        aria-label="Group by"
        className={selectCls}
        value={filters.groupBy ?? ''}
        onChange={(e) => onChange({ ...filters, groupBy: (e.target.value || undefined) as GroupByKey | undefined })}
      >
        <option value="">No grouping</option>
        {GROUP_BY_KEYS.filter((g) => productFitEnabled || g !== 'product_fit').map((g) => (
          <option key={g} value={g}>
            Group by {GROUP_LABELS[g]}
          </option>
        ))}
      </select>
      <input
        type="search"
        aria-label="Search prospects"
        placeholder="Search company or contact"
        value={q}
        onChange={(e) => onSearch(e.target.value)}
        className="w-56 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
      />
      <label className="ml-1 flex items-center gap-1.5 text-[13px] text-slate-600">
        <input
          type="checkbox"
          checked={!!filters.showPromoted}
          onChange={(e) => onChange({ ...filters, showPromoted: e.target.checked || undefined })}
        />
        Show promoted
      </label>
      {actions}
    </div>
  );
}
