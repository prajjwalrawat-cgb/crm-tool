'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { ProspectStage } from '@/db/schema';
import type { PromoteOutcome } from '@/lib/prospects/promote/promote';

import type { PromoteSeed } from './promote-dialog';
import { PROSPECT_STAGES } from '@/lib/prospects/rules';

import { STAGE_LABELS } from './prospect-column';

/** `name` is snapshotted before the call: promoted cards leave the board on revalidate. */
export type PromoteResults = { id: string; name?: string; outcome: PromoteOutcome }[];

export type BulkResult = { label: string; moved: number; skipped: { id: string; reason: string }[] };

type Props = {
  count: number;
  canPark: boolean;
  canRelease: boolean;
  canPromote: boolean;
  busy: boolean;
  result: BulkResult | null;
  promoteResults: PromoteResults | null;
  /** id to company name, for the skipped list. */
  names: Map<string, string>;
  onMove: (to: ProspectStage) => void;
  onRelease: () => void;
  onPromote: (ignoreWarnings: boolean) => void;
  onOpenPromote: (id: string, seed: PromoteSeed) => void;
  onDismissPromote: () => void;
  onClear: () => void;
  onDismissResult: () => void;
};

const REASONS: Record<string, string> = {
  claimed_by_other: 'Claimed by someone else',
  promoted: 'Already promoted',
  deleted: 'Deleted',
  not_found: 'Not found',
  not_claimed: 'Not claimed',
  out_of_scope: 'Outside your team',
  no_permission: 'No permission',
  invalid: 'Invalid',
  error: 'Failed',
};

export function BulkBar({ count, canPark, canRelease, canPromote, busy, result, promoteResults, names, onMove, onRelease, onPromote, onOpenPromote, onDismissPromote, onClear, onDismissResult }: Props) {
  const [to, setTo] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [ignoreWarnings, setIgnoreWarnings] = useState(false);
  if (count === 0 && !result && !promoteResults) return null;
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
          {canRelease ? (
            <button
              type="button"
              disabled={busy}
              onClick={onRelease}
              className="rounded-md border border-slate-300 px-3 py-1 text-[13px] text-slate-700 disabled:opacity-50"
            >
              Release claims
            </button>
          ) : null}
          {canPromote ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming((v) => !v)}
              className="rounded-md border border-slate-300 px-3 py-1 text-[13px] text-slate-700 disabled:opacity-50"
            >
              Promote
            </button>
          ) : null}
          <button type="button" onClick={onClear} className="ml-auto text-[12px] text-slate-500 hover:text-slate-700">
            Clear
          </button>
        </div>
      ) : null}
      {count > 0 && confirming ? (
        <div className="mt-2 border-t border-slate-100 pt-2 text-[13px] text-slate-800">
          <p>
            Promote {count} {count === 1 ? 'prospect' : 'prospects'} to leads?
          </p>
          <label className="mt-1 flex items-center gap-2 text-[12px] text-slate-600">
            <input type="checkbox" checked={ignoreWarnings} onChange={(e) => setIgnoreWarnings(e.target.checked)} />
            Ignore similar-name warnings
          </label>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onPromote(ignoreWarnings);
              }}
              className="rounded-md bg-indigo-600 px-3 py-1 text-[13px] font-medium text-white disabled:opacity-50"
            >
              Confirm promote
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="text-[12px] text-slate-500 hover:text-slate-700">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {promoteResults ? (
        <div role="status" className={count > 0 ? 'mt-2 border-t border-slate-100 pt-2' : ''}>
          <div className="flex items-center justify-between text-[13px] text-slate-800">
            <span>
              Promoted {promoteResults.filter((r) => r.outcome.status === 'promoted').length} of {promoteResults.length}
            </span>
            <button type="button" onClick={onDismissPromote} className="text-[12px] text-slate-500 hover:text-slate-700">
              Dismiss
            </button>
          </div>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-[12px] text-slate-700">
            {promoteResults.map(({ id, name, outcome }) => (
              <li key={id} className="flex items-center gap-2">
                <span className="font-medium">{name ?? names.get(id) ?? 'Prospect'}</span>
                {outcome.status === 'promoted' ? (
                  <>
                    <span className="text-slate-500">{outcome.linked ? 'Linked to the existing lead' : 'Promoted'}</span>
                    <Link href={`/dashboard/deals/${outcome.dealId}`} className="text-indigo-700 underline">
                      Open lead →
                    </Link>
                  </>
                ) : outcome.status === 'blocked' ? (
                  <>
                    <span className="text-amber-700">Matches existing records</span>
                    <button type="button" onClick={() => onOpenPromote(id, { kind: 'blocked', candidates: outcome.candidates })} className="text-indigo-700 underline">
                      Open
                    </button>
                  </>
                ) : outcome.status === 'warn' ? (
                  <>
                    <span className="text-amber-700">Similar name</span>
                    <button type="button" onClick={() => onOpenPromote(id, { kind: 'warn', candidates: outcome.candidates })} className="text-indigo-700 underline">
                      Open
                    </button>
                  </>
                ) : (
                  <span className="text-red-700">{outcome.message}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result ? (
        <div role="status" className={count > 0 ? 'mt-2 border-t border-slate-100 pt-2' : ''}>
          <div className="flex items-center justify-between text-[13px] text-slate-800">
            <span>
              {result.label} {result.moved}, skipped {result.skipped.length}
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
