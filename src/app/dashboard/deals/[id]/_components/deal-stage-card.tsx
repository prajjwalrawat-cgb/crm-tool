'use client';

import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { updateDealStageAction } from '@/app/dashboard/deals/actions';
import {
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  type DealStage,
} from '@/lib/deals/schema';

import { ClearCloseDateModal } from '../../_components/clear-close-date-modal';
import { LostReasonModal } from '../../_components/lost-reason-modal';

/**
 * Stage as an editable Deal Info card. Stage isn't a plain field patch — it
 * runs through `updateDealStageAction` so gates, approvals, the Lost reason
 * and the Lead close-date trade all apply exactly as they do on the board.
 */
export function DealStageCard({
  dealId,
  dealName,
  stage,
  expectedCloseDate,
  canEdit,
}: {
  dealId: string;
  dealName: string;
  stage: DealStage;
  expectedCloseDate: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DealStage>(stage);
  const [pending, startTransition] = useTransition();
  const [lostPrompt, setLostPrompt] = useState(false);
  const [clearDatePrompt, setClearDatePrompt] = useState(false);

  // Adopt the server's stage on a fresh render while idle.
  const [syncedStage, setSyncedStage] = useState(stage);
  if (syncedStage !== stage && !editing) {
    setSyncedStage(stage);
    setDraft(stage);
  }

  function commit(next: DealStage, opts?: { reason?: string; clearCloseDate?: boolean }) {
    setEditing(false);
    startTransition(async () => {
      const result = await updateDealStageAction({
        id: dealId,
        stage: next,
        reason: opts?.reason,
        clearCloseDate: opts?.clearCloseDate,
      });
      if (!result.ok) {
        // Dated deal going back to Lead — offer the trade instead of an error.
        if (result.needsCloseDateClear) {
          setClearDatePrompt(true);
          return;
        }
        toast.error(result.message);
        setDraft(stage);
        return;
      }
      router.refresh();
    });
  }

  function apply() {
    if (draft === stage) {
      setEditing(false);
      return;
    }
    if (draft === 'lost') {
      setLostPrompt(true);
      return;
    }
    if (draft === 'lead' && expectedCloseDate) {
      setEditing(false);
      setClearDatePrompt(true);
      return;
    }
    commit(draft);
  }

  return (
    <div className="group relative rounded-lg border border-slate-200 bg-white p-3 transition hover:border-slate-300">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Stage
        </span>
        {canEdit ? (
          editing ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={apply}
                aria-label="Save stage"
                className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(stage);
                  setEditing(false);
                }}
                aria-label="Cancel editing stage"
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Edit stage"
              className="rounded p-0.5 text-slate-300 opacity-0 transition hover:bg-slate-100 hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          )
        ) : null}
      </div>

      {editing ? (
        <select
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value as DealStage)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(stage);
              setEditing(false);
            }
          }}
          className="mt-1.5 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px]"
        >
          {DEAL_STAGES.map((s) => (
            <option key={s} value={s}>
              {DEAL_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      ) : (
        <div
          className={`mt-1 text-[15px] font-medium text-slate-900 ${pending ? 'opacity-50' : ''}`}
        >
          {DEAL_STAGE_LABELS[stage]}
        </div>
      )}

      {lostPrompt ? (
        <LostReasonModal
          dealName={dealName}
          pending={pending}
          onCancel={() => {
            setLostPrompt(false);
            setDraft(stage);
          }}
          onConfirm={(reason) => {
            setLostPrompt(false);
            commit('lost', { reason });
          }}
        />
      ) : null}

      {clearDatePrompt ? (
        <ClearCloseDateModal
          dealName={dealName}
          closeDate={expectedCloseDate}
          pending={pending}
          onCancel={() => {
            setClearDatePrompt(false);
            setDraft(stage);
          }}
          onConfirm={() => {
            setClearDatePrompt(false);
            commit('lead', { clearCloseDate: true });
          }}
        />
      ) : null}
    </div>
  );
}
