'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  FORECAST_CATEGORIES,
  FORECAST_CATEGORY_LABELS,
} from '@/lib/deals/forecast/categories';

import { updateDealForecastCategoryAction } from '../actions';

/**
 * Manager control to override a deal's forecast category. "Auto" clears the
 * override and re-derives from the current stage. When overridden, stage
 * changes leave the category alone.
 */
export function ForecastCategorySelect({
  dealId,
  current,
  overridden,
  canEdit,
}: {
  dealId: string;
  current: string | null;
  overridden: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // 'auto' represents "follow the stage" (not overridden).
  const [value, setValue] = useState(overridden ? current ?? 'auto' : 'auto');

  function onChange(next: string) {
    setValue(next);
    startTransition(async () => {
      const res = await updateDealForecastCategoryAction({
        dealId,
        category: next,
      });
      if (!res.ok) {
        toast.error(res.message);
        setValue(overridden ? current ?? 'auto' : 'auto');
      } else {
        toast.success(
          res.overridden ? 'Forecast category overridden' : 'Following stage',
        );
        router.refresh();
      }
    });
  }

  const derivedLabel =
    !overridden && current ? FORECAST_CATEGORY_LABELS[current as never] : null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        Forecast category
      </div>
      {canEdit ? (
        <div className="mt-1 flex items-center gap-2">
          <select
            value={value}
            disabled={pending}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] text-slate-900 dark:border-[#333] dark:bg-[#161616] dark:text-[#FAFAFA]"
          >
            <option value="auto">
              Auto{derivedLabel ? ` (${derivedLabel})` : ' (follow stage)'}
            </option>
            {FORECAST_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {FORECAST_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
          ) : null}
        </div>
      ) : (
        <div className="mt-1 text-[15px] font-medium text-slate-900 dark:text-[#FAFAFA]">
          {current ? FORECAST_CATEGORY_LABELS[current as never] ?? current : '—'}
          {overridden ? (
            <span className="ml-1.5 text-[10px] font-normal uppercase text-indigo-500">
              overridden
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
