'use client';

import { Loader2, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';

import { DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import {
  ROLLBACK_REASONS,
  ROLLBACK_REASON_LABELS,
  type RollbackReason,
} from '@/lib/deals/stage-governance';

/**
 * Prompt shown BEFORE a backward stage move commits (R2).
 *
 * Deliberately blocks the transition rather than letting the drop land and
 * then apologising with a toast: a drop-then-error flow trains people to
 * ignore the error, and the reason is the entire point of the rule. Cancel
 * rolls the card back to where it came from.
 *
 * The reason starts UNSELECTED. A pre-filled dropdown would make
 * "Requirement changed" the answer for every rollback in the workspace within
 * a week, which is the same as having no reason at all — so Confirm stays
 * disabled until someone actually picks one.
 */
export function RollbackReasonModal({
  dealName,
  fromStage,
  toStage,
  pending,
  onCancel,
  onConfirm,
}: {
  dealName: string;
  fromStage: DealStage | string;
  toStage: DealStage | string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (reason: RollbackReason, note: string) => void;
}) {
  const [reason, setReason] = useState<RollbackReason | ''>('');
  const [note, setNote] = useState('');
  const canSubmit = reason !== '';

  const fromLabel = DEAL_STAGE_LABELS[fromStage as DealStage] ?? fromStage;
  const toLabel = DEAL_STAGE_LABELS[toStage as DealStage] ?? toStage;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-[#1F1F1F] dark:bg-[#0A0A0A]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              <Undo2 className="h-4 w-4 text-amber-600" aria-hidden />
              Move this deal backward?
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              <span className="font-medium">{dealName}</span> is going from{' '}
              <span className="font-medium">{fromLabel}</span> back to{' '}
              <span className="font-medium">{toLabel}</span>. Backward moves are
              recorded, so this needs a reason.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800/60"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-3 space-y-3">
          <label className="flex flex-col gap-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
            Reason<span className="text-red-500">*</span>
            <select
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value as RollbackReason | '')}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
            >
              <option value="" disabled>
                Pick a reason…
              </option>
              {ROLLBACK_REASONS.map((r) => (
                <option key={r} value={r}>
                  {ROLLBACK_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
            Note (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. Client reopened the RFP after a new stakeholder joined"
              className="resize-y rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
            />
          </label>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-[13px] hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:hover:bg-slate-800/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (reason === '') return;
              onConfirm(reason, note.trim());
            }}
            disabled={!canSubmit || pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Move back
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
