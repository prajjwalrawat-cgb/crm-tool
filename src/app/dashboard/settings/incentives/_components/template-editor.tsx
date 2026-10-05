'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { validatePlanTerms } from '@/lib/incentives/engine';
import type { StoredTerms } from '@/lib/incentives/terms';

import { saveTemplateAction } from '../../../incentives/actions';
import { TermsForm, inputClass } from './terms-form';

/**
 * The workspace default plan. New plans start from it; existing plans are
 * NOT changed when it changes (that's what the bulk tool is for, with a
 * preview), so editing the template can't silently move anyone's payout.
 */
export function TemplateEditor({ initialTerms, initialBudget }: { initialTerms: StoredTerms; initialBudget: string | null }) {
  const router = useRouter();
  const [terms, setTerms] = useState(initialTerms);
  const [budget, setBudget] = useState(initialBudget ?? '');
  const [pending, start] = useTransition();
  const issues = validatePlanTerms(terms);

  return (
    <div>
      <TermsForm value={terms} onChange={setTerms} disabled={pending} />
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3 dark:border-[#1F1F1F]">
        <label className="block">
          <span className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">FY incentive budget</span>
          <span className="mt-1 flex items-center gap-1.5">
            <input type="number" min="0" step="any" value={budget} onChange={(e) => setBudget(e.target.value)} className={`${inputClass} w-40`} placeholder="optional" />
            <span className="text-[12px] text-slate-500">₹ L</span>
          </span>
        </label>
        <button
          type="button"
          disabled={pending || issues.length > 0}
          onClick={() =>
            start(async () => {
              const res = await saveTemplateAction({ terms, budgetL: budget });
              if (res.ok) {
                toast.success('Template saved. Existing plans are unchanged.');
                router.refresh();
              } else {
                toast.error(res.message);
              }
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          Save template
        </button>
        {issues.length > 0 ? <span className="text-[12px] text-rose-600">{issues.join(' · ')}</span> : null}
      </div>
    </div>
  );
}
