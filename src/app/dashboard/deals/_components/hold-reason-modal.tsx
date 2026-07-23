'use client';

import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';

import { HOLD_REASONS, HOLD_REASON_LABELS, type HoldReason } from '@/lib/deals/hold';

/**
 * Prompt shown before a deal is parked in Hold (Module 6). A reason code and a
 * "revisit on" date are required; the note is optional. Cancel aborts the move.
 */
export function HoldReasonModal({
  dealName,
  pending,
  onCancel,
  onConfirm,
}: {
  dealName: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (reason: HoldReason, revisitOn: string, note: string) => void;
}) {
  const [reason, setReason] = useState<HoldReason>('budget_deferred');
  const [revisitOn, setRevisitOn] = useState('');
  const [note, setNote] = useState('');
  const canSubmit = Boolean(reason && revisitOn);

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
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              Put deal on Hold
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Park <span className="font-medium">{dealName}</span> with a reason
              and a date to revisit it.
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
            Reason
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as HoldReason)}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
            >
              {HOLD_REASONS.map((r) => (
                <option key={r} value={r}>
                  {HOLD_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
            Revisit on<span className="text-red-500">*</span>
            <input
              type="date"
              value={revisitOn}
              onChange={(e) => setRevisitOn(e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
            />
          </label>

          <label className="flex flex-col gap-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
            Note (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. Client asked to reconnect next quarter"
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
            onClick={() => onConfirm(reason, revisitOn, note.trim())}
            disabled={!canSubmit || pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Put on Hold
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
