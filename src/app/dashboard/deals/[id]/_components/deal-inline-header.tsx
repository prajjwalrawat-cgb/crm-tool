'use client';

import {
  Check,
  Loader2,
  Pencil,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { updateDealAction } from '@/app/dashboard/deals/actions';
import { formatCurrency, KNOWN_CURRENCIES } from '@/lib/deals/currency';
import { DEAL_STAGES, DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import { useRealtimeEventOfType } from '@/hooks/use-realtime-events';
import { cn } from '@/lib/utils';

import { LostReasonModal } from '../../_components/lost-reason-modal';
import { StageBadge } from '../../_components/stage-badge';

/**
 * Composite inline-edit header for a deal. Renders read-only chrome
 * by default; toggling Edit reveals controls for title / stage /
 * amount / currency / expected close.
 *
 * Behavior:
 *   - **Optimistic update**: local state applies immediately on save.
 *     Server action runs in the background; on success the realtime
 *     `deal.updated` event reconciles. On failure we revert + toast.
 *   - **Realtime reconcile**: subscribes to `deal.updated` events
 *     filtered to this dealId and merges incoming changes. Lets two
 *     tabs editing the same deal converge.
 *   - **Keyboard**: Cmd/Ctrl+S saves, Esc cancels.
 *   - **Dirty detection**: Save button disables when nothing changed.
 *
 * Owner / company / contact edits are NOT in this header — they keep
 * their dedicated pickers below (lower risk + better UX for those
 * particular controls).
 */

type Editable = {
  name: string;
  stage: DealStage;
  amountMajor: string;
  currency: string;
  expectedCloseDate: string | null;
};

export function DealInlineHeader({
  initial,
  initialLostReason,
  dealId,
  companyId,
  contactId,
  canEdit,
  tenantId,
}: {
  initial: Editable;
  initialLostReason: string | null;
  dealId: string;
  companyId: string | null;
  contactId: string | null;
  canEdit: boolean;
  tenantId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Editable>(initial);
  const [committed, setCommitted] = useState<Editable>(initial);
  const [pending, startTransition] = useTransition();
  // Current lost reason — sent through on every save while the deal is Lost so
  // an unrelated edit doesn't drop it; updated when the prompt captures a new
  // one. A permanent copy also lives in the activity log.
  const [lostReason, setLostReason] = useState(initialLostReason ?? '');
  const [lostPromptOpen, setLostPromptOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reconcile from realtime when another tab/user updates the deal.
  useRealtimeEventOfType(tenantId, 'deal.updated', (event) => {
    if (event.deal.id !== dealId) return;
    const next: Editable = {
      name: event.deal.name,
      stage: event.deal.stage as DealStage,
      amountMajor: (event.deal.amountMinor / 100).toFixed(2),
      currency: event.deal.currency,
      expectedCloseDate: event.deal.expectedCloseDate ?? null,
    };
    setCommitted(next);
    if (!editing) setDraft(next);
  });

  const isDirty =
    draft.name !== committed.name ||
    draft.stage !== committed.stage ||
    draft.amountMajor !== committed.amountMajor ||
    draft.currency !== committed.currency ||
    draft.expectedCloseDate !== committed.expectedCloseDate;

  const doSave = useCallback(
    (reasonOverride?: string) => {
      const optimistic = { ...draft };
      // Optimistic UI update: commit locally; revert on failure.
      setCommitted(optimistic);
      setEditing(false);
      if (reasonOverride !== undefined) setLostReason(reasonOverride);

      startTransition(async () => {
        const formData = new FormData();
        formData.set('id', dealId);
        formData.set('name', optimistic.name);
        formData.set('stage', optimistic.stage);
        formData.set('amount', optimistic.amountMajor || '0');
        formData.set('currency', optimistic.currency);
        formData.set('expectedCloseDate', optimistic.expectedCloseDate ?? '');
        formData.set('companyId', companyId ?? '');
        formData.set('contactId', contactId ?? '');
        // While Lost, always resend the reason (new one, or the existing one)
        // so a plain amount/name edit doesn't clear it.
        if (optimistic.stage === 'lost') {
          const r = reasonOverride ?? lostReason;
          if (r) formData.set('lostReason', r);
        }
        const result = await updateDealAction(formData);
        if (!result.ok) {
          toast.error(result.message);
          // Revert.
          setCommitted(committed);
          setDraft(committed);
          return;
        }
      });
    },
    [committed, companyId, contactId, dealId, draft, lostReason],
  );

  const save = useCallback(() => {
    if (!isDirty || pending) {
      setEditing(false);
      return;
    }
    // Prompt for a reason when moving the deal INTO the Lost stage.
    if (draft.stage === 'lost' && committed.stage !== 'lost') {
      setLostPromptOpen(true);
      return;
    }
    doSave();
  }, [committed.stage, doSave, draft.stage, isDirty, pending]);

  const cancel = useCallback(() => {
    setDraft(committed);
    setEditing(false);
  }, [committed]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
      if (isSave) {
        e.preventDefault();
        save();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, editing, save]);

  // Read-only display values come from `committed`. While editing we
  // show `draft` so the user sees their pending typing.
  const display = editing ? draft : committed;
  const amountMinor = Math.round(Number(display.amountMajor || '0') * 100);
  const formattedAmount = formatCurrency(amountMinor, display.currency);

  return (
    <div
      ref={rootRef}
      className={cn(
        'mt-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-5 dark:border-[#1F1F1F]',
        editing && 'rounded-lg border bg-slate-50/60 px-4 pt-3 dark:bg-[#0A0A0A]',
      )}
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xl font-semibold tracking-tight text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
            autoFocus
          />
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {display.name}
          </h1>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
          {editing ? (
            <>
              <label className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide">Stage</span>
                <select
                  value={draft.stage}
                  onChange={(e) =>
                    setDraft({ ...draft, stage: e.target.value as DealStage })
                  }
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
                >
                  {DEAL_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {DEAL_STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide">Amount</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.amountMajor}
                  onChange={(e) =>
                    setDraft({ ...draft, amountMajor: e.target.value })
                  }
                  className="w-28 rounded-md border border-slate-200 bg-white px-2 py-1 text-right font-mono text-[12.5px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
                />
                <select
                  value={draft.currency}
                  onChange={(e) =>
                    setDraft({ ...draft, currency: e.target.value })
                  }
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
                >
                  {KNOWN_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide">Close</span>
                <input
                  type="date"
                  value={draft.expectedCloseDate ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      expectedCloseDate: e.target.value || null,
                    })
                  }
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
                />
              </label>
            </>
          ) : (
            <>
              <span>{DEAL_STAGE_LABELS[display.stage]}</span>
              <span aria-hidden>·</span>
              <span className="font-mono">{formattedAmount}</span>
              {display.expectedCloseDate ? (
                <>
                  <span aria-hidden>·</span>
                  <span>close {display.expectedCloseDate}</span>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {!editing ? <StageBadge stage={display.stage} /> : null}
        {canEdit ? (
          editing ? (
            <>
              <button
                type="button"
                onClick={cancel}
                disabled={pending}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-[12.5px] font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#A1A1AA] dark:hover:bg-[#111111]"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!isDirty || pending}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-md bg-indigo-600 px-2.5 text-[12.5px] font-medium text-white transition-colors hover:bg-indigo-500',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                )}
                Save
                <kbd className="ml-1 hidden rounded border border-white/30 px-1 text-[9px] sm:inline">
                  ⌘S
                </kbd>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 dark:border-[#1F1F1F] dark:text-[#A1A1AA] dark:hover:bg-[#111111] dark:hover:text-[#FAFAFA]"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </button>
          )
        ) : null}
      </div>

      {lostPromptOpen ? (
        <LostReasonModal
          dealName={draft.name}
          onCancel={() => setLostPromptOpen(false)}
          onConfirm={(reason) => {
            setLostPromptOpen(false);
            doSave(reason);
          }}
        />
      ) : null}
    </div>
  );
}
