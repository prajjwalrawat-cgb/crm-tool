'use client';

import { AlertTriangle, Clock } from 'lucide-react';
import { useState } from 'react';

import type { DealStage } from '@/db/schema';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

type Entry = {
  stage: DealStage;
  durationDays: number;
  isCurrent: boolean;
};

/**
 * Time-in-stage card. Shows how long the deal has sat in its current stage and
 * an expandable stepped bar of the full stage journey. Segments turn red when
 * the current stage has run past the tenant's historical average for that
 * stage — the pipeline-hygiene "this is stalling" signal.
 */
export function StageHistoryCard({
  entries,
  currentDurationDays,
  staleReason,
  avgForCurrent,
}: {
  entries: Entry[];
  currentDurationDays: number | null;
  staleReason: 'exceeds-average' | 'long-in-stage' | null;
  avgForCurrent: number | null;
}) {
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  const isStale = staleReason != null;
  const maxDuration = Math.max(1, ...entries.map((e) => e.durationDays));

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">
          Time in stage
        </div>
        {entries.length > 1 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
          >
            {open ? 'Hide' : 'History'}
          </button>
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-sm">
        <Clock
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            isStale ? 'text-rose-500' : 'text-slate-400',
          )}
          aria-hidden
        />
        <span className={cn(isStale && 'text-rose-700')}>
          {currentDurationDays != null
            ? `In this stage for ${currentDurationDays} ${
                currentDurationDays === 1 ? 'day' : 'days'
              }`
            : '—'}
        </span>
      </div>

      {staleReason === 'exceeds-average' && avgForCurrent != null ? (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-rose-600">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          Past the {Math.round(avgForCurrent)}-day average for this stage — may
          be stalling.
        </p>
      ) : staleReason === 'long-in-stage' ? (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-rose-600">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          Unusually long in this stage — may be stalling. (No stage average to
          compare against yet.)
        </p>
      ) : null}

      {open ? (
        <div className="mt-3 space-y-1.5">
          {entries.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className={cn(
                  'w-24 shrink-0 truncate text-[11px]',
                  e.isCurrent
                    ? 'font-semibold text-slate-800'
                    : 'text-slate-500',
                )}
              >
                {DEAL_STAGE_LABELS[e.stage]}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    'h-full rounded-full',
                    e.isCurrent && isStale
                      ? 'bg-rose-400'
                      : e.isCurrent
                        ? 'bg-indigo-500'
                        : 'bg-slate-300',
                  )}
                  style={{
                    width: `${Math.max(6, (e.durationDays / maxDuration) * 100)}%`,
                  }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-slate-400">
                {e.durationDays}d{e.isCurrent ? ' •' : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
