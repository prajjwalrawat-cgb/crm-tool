'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { recomputeActualsAction } from '../actions';

/** On-demand run of the nightly computed-actuals job, for one plan or all. */
export function RecomputeButton({ planId, label = 'Recompute now' }: { planId?: string; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await recomputeActualsAction({ planId });
          if (res.ok) {
            toast.success(`Recomputed ${res.value.plans} plan${res.value.plans === 1 ? '' : 's'} from deal data`);
            router.refresh();
          } else {
            toast.error(res.message);
          }
        })
      }
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:text-[#D4D4D8] dark:hover:bg-[#181818]"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
      {label}
    </button>
  );
}
