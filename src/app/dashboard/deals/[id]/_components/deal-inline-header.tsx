'use client';

import {
  Check,
  Loader2,
  Pencil,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { patchDealAction } from '@/app/dashboard/deals/actions';
import { marginBpsToPct } from '@/lib/deals/approval';
import { formatCurrency } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import { useRealtimeEventOfType } from '@/hooks/use-realtime-events';
import { cn } from '@/lib/utils';

import { StageBadge } from '../../_components/stage-badge';

/**
 * Deal title bar. Renames the deal in place and renders the stage / amount /
 * close date beneath it as read-only context.
 *
 * Editing anything OTHER than the name happens on its own Deal Info card
 * (see `editable-detail-card.tsx` / `deal-stage-card.tsx`). This header used
 * to edit all of those at once through the full edit-form action, which wrote
 * every deal column from the submitted payload — so the fields it didn't
 * render arrived empty and were nulled. One control per field, each patching
 * only its own columns, makes that class of bug impossible.
 *
 * Behavior:
 *   - **Optimistic rename**: applies locally, reverts + toasts on failure.
 *   - **Realtime reconcile**: `deal.updated` events for this deal merge in,
 *     so two tabs converge.
 *   - **Keyboard**: Cmd/Ctrl+S saves, Esc cancels.
 */

type Editable = {
  name: string;
  stage: DealStage;
  amountMajor: string;
  currency: string;
  expectedCloseDate: string | null;
  /** Margin percent as a string (e.g. "20"). Read-only here. */
  marginPct: string;
};

export function DealInlineHeader({
  initial,
  dealId,
  canEdit,
  tenantId,
}: {
  initial: Editable;
  dealId: string;
  canEdit: boolean;
  tenantId: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Editable>(initial);
  const [committed, setCommitted] = useState<Editable>(initial);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  // Adopt the server's values whenever a fresh render arrives (router.refresh
  // after a save, a revalidation from elsewhere). `initial` is a new object on
  // every render, so compare by value, and never clobber an edit in progress.
  const initialKey = [
    initial.name,
    initial.stage,
    initial.amountMajor,
    initial.currency,
    initial.expectedCloseDate ?? '',
    initial.marginPct,
  ].join('|');
  const [syncedKey, setSyncedKey] = useState(initialKey);
  if (syncedKey !== initialKey && !editing) {
    setSyncedKey(initialKey);
    setCommitted(initial);
    setDraft(initial);
  }

  // Reconcile from realtime when another tab/user updates the deal.
  useRealtimeEventOfType(tenantId, 'deal.updated', (event) => {
    if (event.deal.id !== dealId) return;
    const next: Editable = {
      name: event.deal.name,
      stage: event.deal.stage as DealStage,
      amountMajor: (event.deal.amountMinor / 100).toFixed(2),
      currency: event.deal.currency,
      expectedCloseDate: event.deal.expectedCloseDate ?? null,
      marginPct:
        event.deal.marginBps != null
          ? String(marginBpsToPct(event.deal.marginBps))
          : '',
    };
    setCommitted(next);
    if (!editing) setDraft(next);
  });

  // The header renames the deal; every other field is edited on its own card.
  const isDirty = draft.name.trim() !== committed.name;

  const save = useCallback(() => {
    if (!isDirty || pending) {
      setEditing(false);
      return;
    }
    const name = draft.name.trim();
    if (!name) {
      toast.error('Name is required.');
      return;
    }
    const rollback = committed;
    setCommitted({ ...committed, name });
    setEditing(false);

    startTransition(async () => {
      // Patch only the name — the action leaves every column absent from the
      // payload untouched, which is what keeps a rename from disturbing unit
      // price, description, custom fields and the rest.
      const result = await patchDealAction({ id: dealId, name });
      if (!result.ok) {
        toast.error(result.message);
        setCommitted(rollback);
        setDraft(rollback);
      }
      // Server-rendered siblings (the Deal Info cards, the activity feed) are
      // a separate tree from this component's state — pull the fresh render so
      // the page agrees with itself without a reload.
      router.refresh();
    });
  }, [committed, dealId, draft.name, isDirty, pending, router]);

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

        {/* Read-only context only. Stage, amount, margin and close date are
            edited on their own cards in Deal Info — one control per field,
            each patching just its own columns. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
          <span>{DEAL_STAGE_LABELS[display.stage]}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{formattedAmount}</span>
          {display.expectedCloseDate ? (
            <>
              <span aria-hidden>·</span>
              <span>close {display.expectedCloseDate}</span>
            </>
          ) : null}
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
              Rename
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
