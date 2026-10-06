'use client';

import { BadgeCheck, Clock, Loader2, Pencil } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  approveDealCreditTermsAction,
  setDealCreditTermsAction,
} from '@/app/dashboard/collections/actions';
import { cn } from '@/lib/utils';

type Terms = {
  days: number;
  note: string | null;
  setByName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
};

/**
 * Credit period agreed with the customer on this deal (0069). A period
 * longer than the workspace standard needs a manager/admin's sign-off; until
 * then it shows as unapproved and is flagged in the Collections report. A
 * deal with no terms is treated as the standard, labelled "assumed".
 */
export function DealCreditTermsCard({
  dealId,
  standardDays,
  terms,
  canEdit,
  canApprove,
}: {
  dealId: string;
  standardDays: number;
  terms: Terms | null;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(String(terms?.days ?? standardDays));
  const [note, setNote] = useState(terms?.note ?? '');
  const [pending, start] = useTransition();

  const over = terms ? terms.days > standardDays : false;
  const unapproved = over && !terms?.approvedByName;

  function save() {
    start(async () => {
      const res = await setDealCreditTermsAction({ dealId, days, note: note || null });
      if (res.ok) {
        toast.success(
          res.value.needsApproval && !res.value.approved
            ? 'Saved — longer than standard, waiting for a manager’s approval'
            : 'Credit terms saved',
        );
        setEditing(false);
        router.refresh();
      } else {
        toast.error(res.message);
      }
    });
  }

  function approve() {
    start(async () => {
      const res = await approveDealCreditTermsAction({ dealId });
      if (res.ok) {
        toast.success('Credit terms approved');
        router.refresh();
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0F0F0F]">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">Credit terms</h3>
        {canEdit && !editing ? (
          <button type="button" onClick={() => setEditing(true)} className="text-slate-400 hover:text-indigo-600" aria-label="Edit credit terms">
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </header>

      {editing ? (
        <div className="space-y-2">
          <label className="block text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Agreed credit period (days)
            <input
              type="number"
              min={0}
              max={730}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
            />
          </label>
          {Number(days) > standardDays ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              Longer than the {standardDays}-day standard — {canApprove ? 'saving records your approval.' : 'needs a manager’s approval.'}
            </p>
          ) : null}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Why these terms? (optional)"
            className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
          />
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={pending} className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60">
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600 dark:border-[#1F1F1F] dark:text-[#A1A1AA]">
              Cancel
            </button>
          </div>
        </div>
      ) : terms ? (
        <div className="space-y-1 text-[13px]">
          <p className="font-semibold text-slate-900 dark:text-[#FAFAFA]">
            {terms.days} days
            <span className={cn('ml-2 text-[11px] font-normal', over ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500')}>
              {over ? `${terms.days - standardDays} over the ${standardDays}-day standard` : `within the ${standardDays}-day standard`}
            </span>
          </p>
          {over ? (
            terms.approvedByName ? (
              <p className="flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-400">
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                Approved by {terms.approvedByName}
                {terms.approvedAt ? ` on ${new Date(terms.approvedAt).toLocaleDateString('en-IN')}` : ''}
              </p>
            ) : (
              <p className="flex items-center gap-1 text-[12px] text-amber-700 dark:text-amber-300">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                Not approved — flagged in the Collections report
              </p>
            )
          ) : null}
          {terms.note ? <p className="text-[12px] text-slate-500">“{terms.note}”</p> : null}
          {terms.setByName ? <p className="text-[11px] text-slate-400">Set by {terms.setByName}</p> : null}
          {unapproved && canApprove ? (
            <button type="button" onClick={approve} disabled={pending} className="mt-1 rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:opacity-60">
              Approve {terms.days}-day terms
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          Not recorded — counted as the {standardDays}-day standard (assumed).
        </p>
      )}
    </section>
  );
}
