'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { fmtDeltaL, fmtL } from '@/lib/incentives/format';
import type { PlanStatus } from '@/lib/incentives/rollup';
import { BULK_TERM_KEYS, TERM_FIELDS, type StoredTerms, type TermKey } from '@/lib/incentives/terms';
import { cn } from '@/lib/utils';

import { Panel } from '../../../incentives/_components/incentive-calculator';
import { applyBulkChangeAction, previewBulkChangeAction, type BulkPreviewResult } from '../../../incentives/actions';
import { TermInput, inputClass } from './terms-form';

/**
 * Change rule terms across every plan in a fiscal year — preview first,
 * per resource, then apply exactly the previewed change. Changing the
 * inputs after a preview discards it, so "Apply" is only ever enabled for
 * numbers that are on screen.
 */
export function BulkChange({
  fiscalYear,
  fiscalLabel,
  template,
  names,
}: {
  fiscalYear: number;
  fiscalLabel: string;
  template: StoredTerms;
  names: Record<string, string>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<TermKey[]>(['slab2RateL']);
  const [values, setValues] = useState<StoredTerms>(template);
  const [statuses, setStatuses] = useState<PlanStatus[]>(['active']);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<BulkPreviewResult | null>(null);
  const [pending, start] = useTransition();

  const change = Object.fromEntries(selected.map((k) => [k, values[k]]));
  const invalidate = () => setPreview(null);

  function runPreview() {
    start(async () => {
      const res = await previewBulkChangeAction({ fiscalYear, statuses, change });
      if (res.ok) setPreview(res.value);
      else toast.error(res.message);
    });
  }

  function apply() {
    if (!preview) return;
    if (!window.confirm(`Apply to ${preview.planCount} plan(s)? Projected spend moves ${fmtDeltaL(preview.totalDeltaL)}. Each plan gets a new version.`)) return;
    start(async () => {
      const res = await applyBulkChangeAction({ fiscalYear, statuses, change, planVersions: preview.planVersions, note: note || null });
      if (res.ok) {
        toast.success(`Updated ${res.value.updated} plan(s)`);
        setPreview(null);
        router.refresh();
      } else {
        toast.error(res.message);
        if (res.conflict) setPreview(null);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Panel title={`Bulk rule change · ${fiscalLabel}`}>
        <p className="mb-3 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          Tick the rules to change and set their new values. CTC and target variable stay per resource. Starting values come
          from the workspace template.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TERM_FIELDS.filter((f) => BULK_TERM_KEYS.includes(f.key)).map((f) => {
            const on = selected.includes(f.key);
            return (
              <div key={f.key} className={cn('rounded-md border p-2', on ? 'border-indigo-300 dark:border-indigo-500/40' : 'border-slate-100 opacity-70 dark:border-[#1F1F1F]')}>
                <label className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      invalidate();
                      setSelected((s) => (e.target.checked ? [...s, f.key] : s.filter((k) => k !== f.key)));
                    }}
                    className="h-3.5 w-3.5 accent-indigo-600"
                  />
                  Change
                </label>
                <TermInput
                  field={f}
                  value={values[f.key]}
                  disabled={!on}
                  onChange={(v) => {
                    invalidate();
                    setValues((cur) => ({ ...cur, [f.key]: v }) as StoredTerms);
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-slate-100 pt-3 dark:border-[#1F1F1F]">
          <fieldset className="text-[12px] text-slate-700 dark:text-[#D4D4D8]">
            <legend className="mb-1 font-medium">Apply to plans that are</legend>
            {(['active', 'draft'] as const).map((s) => (
              <label key={s} className="mr-3 inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={statuses.includes(s)}
                  onChange={(e) => {
                    invalidate();
                    setStatuses((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)));
                  }}
                  className="h-3.5 w-3.5 accent-indigo-600"
                />
                {s}
              </label>
            ))}
          </fieldset>
          <label className="block min-w-[16rem] flex-1">
            <span className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Change note (audit trail)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={`${inputClass} mt-1`} />
          </label>
          <button
            type="button"
            onClick={runPreview}
            disabled={pending || selected.length === 0 || statuses.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending && !preview ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Preview impact
          </button>
        </div>
      </Panel>

      {preview ? (
        <Panel
          title="Payout impact at current actuals"
          aside={
            <button
              type="button"
              onClick={apply}
              disabled={pending || preview.invalidCount > 0 || preview.planCount === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Apply to {preview.planCount} plan{preview.planCount === 1 ? '' : 's'}
            </button>
          }
        >
          {preview.invalidCount > 0 ? (
            <p className="mb-2 text-[12px] text-rose-600">{preview.invalidCount} plan(s) would become invalid — fix the values; nothing can be applied.</p>
          ) : null}
          <table className="w-full text-[13px] tabular-nums">
            <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              <tr>
                <th className="py-1.5 font-medium">Resource</th>
                <th className="py-1.5 text-right font-medium">Now</th>
                <th className="py-1.5 text-right font-medium">After</th>
                <th className="py-1.5 text-right font-medium">Change</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.planId} className="border-t border-slate-100 dark:border-[#1F1F1F]">
                  <td className="py-1.5">{names[r.userId] ?? r.userId}</td>
                  <td className="py-1.5 text-right">{fmtL(r.beforeL)}</td>
                  <td className="py-1.5 text-right">{fmtL(r.afterL)}</td>
                  <td className={cn('py-1.5 text-right font-medium', r.deltaL > 0 && 'text-emerald-700', r.deltaL < 0 && 'text-rose-700')}>
                    {fmtDeltaL(r.deltaL)}
                  </td>
                  <td className="py-1.5 pl-3 text-[11px] text-slate-500">
                    {r.error ? <span className="text-rose-600">{r.error}</span> : r.usedZeroActuals ? 'no actuals — shown at ₹0 revenue' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-slate-200 font-semibold dark:border-[#2A2A2A]">
              <tr>
                <td className="py-1.5">Total</td>
                <td className="py-1.5 text-right">{fmtL(preview.totalBeforeL)}</td>
                <td className="py-1.5 text-right">{fmtL(preview.totalAfterL)}</td>
                <td className="py-1.5 text-right">{fmtDeltaL(preview.totalDeltaL)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </Panel>
      ) : null}
    </div>
  );
}
