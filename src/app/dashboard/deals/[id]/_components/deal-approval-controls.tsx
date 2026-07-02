'use client';

import { Check, Loader2, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { approveDealAction, rejectDealAction } from '../../actions';

/**
 * Manager approve/reject controls for a deal sitting at the Won stage
 * awaiting sign-off. Rendered only when the viewer can approve and the deal
 * is 'pending'. Approving makes the win count toward sales targets; rejecting
 * reopens the deal to Negotiation.
 */
export function DealApprovalControls({ dealId }: { dealId: string }) {
  const [pending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  function approve() {
    startTransition(async () => {
      const res = await approveDealAction(dealId);
      if (res.ok) toast.success('Deal approved');
      else toast.error(res.message);
    });
  }

  function reject() {
    startTransition(async () => {
      const res = await rejectDealAction({ id: dealId, reason });
      if (res.ok) {
        toast.success('Deal rejected — reopened to Negotiation');
        setRejecting(false);
        setReason('');
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="text-[10px] uppercase tracking-wide text-amber-700">
        Awaiting your approval
      </div>
      <p className="mt-1 text-xs text-amber-800">
        This deal was marked Won and needs manager sign-off before it counts
        toward sales targets.
      </p>
      {rejecting ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Reason (optional)"
            className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reject}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <X className="h-3.5 w-3.5" aria-hidden />
              )}
              Confirm reject
            </button>
            <button
              type="button"
              onClick={() => setRejecting(false)}
              disabled={pending}
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            Approve
          </button>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
