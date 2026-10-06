'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { saveCollectionSettingsAction } from '@/app/dashboard/collections/actions';

const input =
  'mt-1 w-32 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] tabular-nums dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]';

export function CreditTermsForm({ standard, excess }: { standard: number; excess: number }) {
  const router = useRouter();
  const [std, setStd] = useState(String(standard));
  const [exc, setExc] = useState(String(excess));
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      <label className="block text-[13px] font-medium text-slate-700 dark:text-[#D4D4D8]">
        Standard credit period
        <span className="ml-2 inline-flex items-center gap-1.5">
          <input type="number" min={0} max={365} value={std} onChange={(e) => setStd(e.target.value)} className={input} />
          <span className="text-[12px] font-normal text-slate-500">days</span>
        </span>
        <span className="mt-1 block text-[12px] font-normal text-slate-500">
          Deals with no recorded terms are counted at this, and anything longer needs a manager’s approval.
        </span>
      </label>
      <label className="block text-[13px] font-medium text-slate-700 dark:text-[#D4D4D8]">
        “Materially above standard” margin
        <span className="ml-2 inline-flex items-center gap-1.5">
          <input type="number" min={0} max={365} value={exc} onChange={(e) => setExc(e.target.value)} className={input} />
          <span className="text-[12px] font-normal text-slate-500">days</span>
        </span>
        <span className="mt-1 block text-[12px] font-normal text-slate-500">
          A high achiever whose average agreed credit is more than standard + this is flagged “Funding customers”.
        </span>
      </label>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await saveCollectionSettingsAction({ standardCreditDays: std, materialExcessDays: exc });
            if (res.ok) {
              toast.success('Saved');
              router.refresh();
            } else {
              toast.error(res.message);
            }
          })
        }
        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        Save
      </button>
    </div>
  );
}
