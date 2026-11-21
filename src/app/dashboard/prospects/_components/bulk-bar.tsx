'use client';

import { useState } from 'react';

import type { ProspectStage } from '@/db/schema';
import { PROSPECT_STAGES } from '@/lib/prospects/rules';

import { STAGE_LABELS } from './prospect-column';

export type BulkResult = { moved: number; skipped: { id: string; reason: string }[] };

type Props = {
  count: number;
  canPark: boolean;
  busy: boolean;
  result: BulkResult | null;
  /** id to company name, for the skipped list. */
  names: Map<string, string>;
  onMove: (to: ProspectStage) => void;
  onClear: () => void;
  onDismissResult: () => void;
};

const REASONS: Record<string, string> = {
  claimed_by_other: 'Claimed by someone else',
  promoted: 'Already promoted',
  deleted: 'Deleted',
  not_found: 'Not found',
  no_permission: 'No permission',
  invalid: 'Invalid',
  error: 'Failed',
};

export function BulkBar({ count, canPark, busy, result, names, onMove, onClear, onDismissResult }: Props) {
  const [to, setTo] = useState('');
  if (count === 0 && !result) return null;
  return (
    <div className="sticky bottom-4 z-20 mx-auto mt-4 w-full max-w-2xl rounded-lg border border-slate-300 bg-white p-3 shadow-lg">
      {count > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-slate-800">{count} selected</span>
          <select
            aria-label="Move to"
            className="rounded-md border border-slate-300 px-2 py-1 text-[13px]"
            value={to}
            disabled={busy}
            onChange={(e) => setTo(e.target.value)}
          >
            <option value="">Move to…</option>
            {PROSPECT_STAGES.filter((s) => s !== 'parked' || canPark).map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!to || busy}
            onClick={() => {
              onMove(to as ProspectStage);
              setTo('');
            }}
            className="rounded-md bg-indigo-600 px-3 py-1 text-[13px] font-medium text-white disabled:opacity-50"
          >
            Move
          </button>
          {canPark ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onMove('parked')}
              className="rounded-md border border-slate-300 px-3 py-1 text-[13px] text-slate-700 disabled:opacity-50"
            >
              Park
            </button>
          ) : null}
          <button type="button" onClick={onClear} className="ml-auto text-[12px] text-slate-500 hover:text-slate-700">
            Clear
          </button>
        </div>
      ) : null}
      {result ? (
        <div role="status" className={count > 0 ? 'mt-2 border-t border-slate-100 pt-2' : ''}>
          <div className="flex items-center justify-between text-[13px] text-slate-800">
            <span>
              Moved {result.moved}, skipped {result.skipped.length}
            </span>
            <button type="button" onClick={onDismissResult} className="text-[12px] text-slate-500 hover:text-slate-700">
              Dismiss
            </button>
          </div>
          {result.skipped.length > 0 ? (
            <details className="mt-1 text-[12px] text-slate-600">
              <summary className="cursor-pointer">Why were some skipped?</summary>
              <ul className="mt-1 list-disc pl-5">
                {result.skipped.map((s) => (
                  <li key={s.id}>
                    {names.get(s.id) ?? s.id}: {REASONS[s.reason] ?? s.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
