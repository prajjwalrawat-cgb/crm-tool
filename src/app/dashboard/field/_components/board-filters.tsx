'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useId } from 'react';

import { cn } from '@/lib/utils';

import { inputCls } from '../../settings/lead-capture/_components/ui';
import { isValidDate, shiftDate } from '../_lib/datetime';

export type BoardFilterState = { date: string; repId: string | null; atRiskOnly: boolean };

const BASE = '/dashboard/field/today';

/** URL for the board with these filters. Today's date and defaults are left out to keep links short. */
export function boardHref(f: BoardFilterState, today: string): string {
  const q = new URLSearchParams();
  if (f.date !== today) q.set('date', f.date);
  if (f.repId) q.set('rep', f.repId);
  if (f.atRiskOnly) q.set('risk', '1');
  const s = q.toString();
  return s ? `${BASE}?${s}` : BASE;
}

const navBtn =
  'rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-[#A1A1AA] dark:hover:bg-[#181818]';

/**
 * Date (with previous / today / next), rep and "Only at risk" filters. Every
 * change calls `onChange` with the full filter state; the board turns that
 * into a URL and navigates, so refreshes keep the filters.
 */
export function BoardFilters({
  value,
  today,
  reps,
  pending,
  onChange,
}: {
  value: BoardFilterState;
  today: string;
  reps: Array<{ id: string; name: string }>;
  pending: boolean;
  onChange: (next: BoardFilterState) => void;
}) {
  const ids = useId();
  const set = (patch: Partial<BoardFilterState>) => onChange({ ...value, ...patch });
  // A rep id from an old link that is no longer in scope still shows, so the select reflects the URL.
  const repOptions =
    value.repId && !reps.some((r) => r.id === value.repId) ? [...reps, { id: value.repId, name: 'Unknown rep' }] : reps;

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3" aria-busy={pending}>
      <div>
        <label htmlFor={`${ids}-date`} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
          Date
        </label>
        <div className="mt-1 flex items-center gap-1">
          <button type="button" className={navBtn} aria-label="Previous day" onClick={() => set({ date: shiftDate(value.date, -1) })}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <input
            id={`${ids}-date`}
            type="date"
            value={value.date}
            onChange={(e) => isValidDate(e.target.value) && set({ date: e.target.value })}
            className={cn(inputCls, 'h-9 w-[9.5rem] text-[13px]')}
          />
          <button type="button" className={navBtn} aria-label="Next day" onClick={() => set({ date: shiftDate(value.date, 1) })}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
          {value.date !== today ? (
            <button
              type="button"
              onClick={() => set({ date: today })}
              className="rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-indigo-600 hover:bg-slate-100 dark:hover:bg-[#181818]"
            >
              Today
            </button>
          ) : null}
        </div>
      </div>

      <div>
        <label htmlFor={`${ids}-rep`} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
          Rep
        </label>
        <select
          id={`${ids}-rep`}
          value={value.repId ?? ''}
          onChange={(e) => set({ repId: e.target.value || null })}
          className={cn(inputCls, 'mt-1 h-9 min-w-[11rem] text-[13px]')}
        >
          <option value="">All reps</option>
          {repOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <label className="flex h-9 cursor-pointer items-center gap-2 text-[13px] text-slate-700 dark:text-[#D4D4D8]">
        <input
          type="checkbox"
          checked={value.atRiskOnly}
          onChange={(e) => set({ atRiskOnly: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
        />
        Only at risk
      </label>
    </div>
  );
}
