'use client';

import { PauseCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { HOLD_REASON_LABELS, type HoldReason } from '@/lib/deals/hold';

import { HoldReasonModal } from '../../_components/hold-reason-modal';
import { updateDealStageAction } from '../../actions';

/**
 * Deal-detail Hold control (Module 6). When the deal is open, offers "Put on
 * hold" (the first-hold path, since the board hides an empty Hold column). When
 * the deal is already held, shows the reason + revisit date.
 */
export function HoldControl({
  dealId,
  dealName,
  stage,
  holdReason,
  holdRevisitOn,
  holdNote,
  canEdit,
}: {
  dealId: string;
  dealName: string;
  stage: string;
  holdReason: string | null;
  holdRevisitOn: string | null;
  holdNote: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (stage === 'hold') {
    return (
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-500/30 dark:bg-orange-500/10">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">
          <PauseCircle className="h-3.5 w-3.5" /> On hold
        </div>
        <div className="mt-1 text-[13px] text-orange-900 dark:text-orange-100">
          {holdReason ? HOLD_REASON_LABELS[holdReason as HoldReason] ?? holdReason : '—'}
          {holdRevisitOn ? (
            <span className="ml-1 text-orange-700 dark:text-orange-300">
              · revisit {holdRevisitOn}
            </span>
          ) : null}
        </div>
        {holdNote ? (
          <div className="mt-1 whitespace-pre-wrap text-[12px] text-orange-800 dark:text-orange-200">
            {holdNote}
          </div>
        ) : null}
      </div>
    );
  }

  // Only open deals can be parked. (Won/lost aren't shown a Hold action.)
  if (stage === 'won' || stage === 'lost' || !canEdit) return null;

  function putOnHold(reason: HoldReason, revisitOn: string, note: string) {
    startTransition(async () => {
      const res = await updateDealStageAction({
        id: dealId,
        stage: 'hold',
        holdReason: reason,
        holdRevisitOn: revisitOn,
        holdNote: note,
      });
      if (!res.ok) toast.error(res.message);
      else {
        toast.success('Deal put on hold.');
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50 dark:border-[#262626] dark:text-[#D4D4D8] dark:hover:bg-[#161616]"
      >
        <PauseCircle className="h-4 w-4" /> Put on hold
      </button>
      {open ? (
        <HoldReasonModal
          dealName={dealName}
          pending={pending}
          onCancel={() => setOpen(false)}
          onConfirm={putOnHold}
        />
      ) : null}
    </>
  );
}
