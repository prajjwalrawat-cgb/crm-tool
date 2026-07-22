'use client';

import { AlertTriangle, ArrowRight, X, XCircle } from 'lucide-react';
import Link from 'next/link';

import { STAGE_LABELS, type GateFailure } from '@/lib/stage-gates/types';
import { cn } from '@/lib/utils';

/**
 * Slide-over shown when a Kanban drag is rejected by a stage gate. Lists every
 * failed rule as a checklist item with a deep-link CTA that opens the deal so
 * the rep is one click from fixing it — never a bare toast.
 */
export function GateBlockPanel({
  dealId,
  dealName,
  toStage,
  failures,
  onClose,
}: {
  dealId: string;
  dealName: string;
  toStage: string;
  failures: GateFailure[];
  onClose: () => void;
}) {
  const stageLabel = STAGE_LABELS[toStage as keyof typeof STAGE_LABELS] ?? toStage;
  const blockers = failures.filter((f) => f.severity === 'block');
  const warnings = failures.filter((f) => f.severity === 'warn');

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]"
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-label={`Can't move ${dealName} to ${stageLabel}`}
        className="animate-in slide-in-from-right relative flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-xl dark:border-[#262626] dark:bg-[#0F0F0F]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-[#1F1F1F]">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
              <XCircle className="h-3.5 w-3.5" /> Move blocked
            </div>
            <h2 className="mt-1 text-[14px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {dealName} → {stageLabel}
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Complete these before the deal can advance.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-[#181818]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {blockers.map((f, i) => (
            <FailureItem key={`b${i}`} failure={f} dealId={dealId} />
          ))}
          {warnings.length > 0 ? (
            <>
              <div className="pt-2 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                Recommended (won&apos;t block)
              </div>
              {warnings.map((f, i) => (
                <FailureItem key={`w${i}`} failure={f} dealId={dealId} />
              ))}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function FailureItem({
  failure,
  dealId,
}: {
  failure: GateFailure;
  dealId: string;
}) {
  const isBlock = failure.severity === 'block';
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5',
        isBlock
          ? 'border-red-100 bg-red-50/60 dark:border-red-500/20 dark:bg-red-500/5'
          : 'border-amber-100 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5',
      )}
    >
      {isBlock ? (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-slate-800 dark:text-[#E4E4E7]">
          {failure.message}
        </p>
        {failure.cta ? (
          <Link
            href={`/dashboard/deals/${dealId}`}
            className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
          >
            {failure.cta.label}
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
