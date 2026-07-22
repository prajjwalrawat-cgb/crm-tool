'use client';

import { Check, X } from 'lucide-react';
import { useState } from 'react';

import type { DealStage } from '@/db/schema';
import {
  PATH_STAGES,
  STAGE_LABELS,
  type GateRuleResult,
} from '@/lib/stage-gates/types';
import { cn } from '@/lib/utils';

/**
 * Salesforce-style Path chevron bar at the top of the deal detail page. The
 * current stage is highlighted; stages already passed read as complete.
 * Hovering (or focusing) a future gated stage reveals its entry requirements
 * with a live ✓/✗ per rule — so a rep discovers what a stage needs BEFORE
 * trying to drag the deal there.
 */
export function DealPathBar({
  currentStage,
  byStage,
}: {
  currentStage: DealStage;
  byStage: Record<string, GateRuleResult[]>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const currentIdx = PATH_STAGES.indexOf(currentStage);
  // A deal that's Lost/Hold isn't on the forward path — anchor to its position
  // conceptually at 0 so the bar still renders sensibly.
  const activeIdx = currentIdx === -1 ? -1 : currentIdx;

  return (
    <div className="mt-4 flex w-full items-stretch overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-[#262626] dark:bg-[#0F0F0F]">
      {PATH_STAGES.map((stage, i) => {
        const rules = byStage[stage] ?? [];
        const isCurrent = stage === currentStage;
        const isPast = activeIdx !== -1 && i < activeIdx;
        const unmet = rules.filter((r) => !r.satisfied);
        const hasGates = rules.length > 0;
        const showPop = open === stage && hasGates;

        return (
          <div
            key={stage}
            className="relative flex-1"
            onMouseEnter={() => setOpen(stage)}
            onMouseLeave={() => setOpen((s) => (s === stage ? null : s))}
          >
            <button
              type="button"
              onFocus={() => setOpen(stage)}
              onBlur={() => setOpen((s) => (s === stage ? null : s))}
              className={cn(
                'flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-medium transition',
                i > 0 &&
                  'border-l border-slate-200 dark:border-[#262626]',
                isCurrent
                  ? 'bg-indigo-600 text-white'
                  : isPast
                    ? 'bg-slate-50 text-slate-500 dark:bg-[#161616] dark:text-[#A1A1AA]'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-[#D4D4D8] dark:hover:bg-[#161616]',
              )}
            >
              <span className="truncate">{STAGE_LABELS[stage]}</span>
              {hasGates && !isCurrent && !isPast ? (
                <span
                  className={cn(
                    'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                    unmet.length === 0
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
                  )}
                >
                  {unmet.length === 0 ? '✓' : unmet.length}
                </span>
              ) : null}
            </button>

            {showPop ? (
              <div className="absolute left-1/2 top-full z-20 mt-1 w-64 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-2.5 shadow-lg dark:border-[#262626] dark:bg-[#141414]">
                <div className="mb-1.5 text-[11px] font-semibold text-slate-700 dark:text-[#E4E4E7]">
                  Requirements to enter {STAGE_LABELS[stage]}
                </div>
                <ul className="space-y-1">
                  {rules.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-start gap-1.5 text-[12px] text-slate-600 dark:text-[#A1A1AA]"
                    >
                      {r.satisfied ? (
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      ) : (
                        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                      )}
                      <span>
                        {r.message}
                        {r.severity === 'warn' ? (
                          <span className="ml-1 text-[10px] uppercase text-amber-500">
                            warn
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
