'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { fmt, type CurrencyCtx } from '@/lib/reports/manager/format';
import type { SourceRoiRow } from '@/lib/reports/manager/services';

import { setSourceSpendAction } from '../actions';
import { EmptyState } from './ui';

/** Source ROI with inline monthly spend editing (managers and above). */
export function SourceRoiTable({
  rows,
  currency,
  showSpend,
  canEditSpend,
  month,
}: {
  rows: SourceRoiRow[];
  currency: CurrencyCtx;
  showSpend: boolean;
  canEditSpend: boolean;
  /** YYYY-MM the inline editor writes to. */
  month: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [pending, start] = useTransition();
  if (rows.length === 0) return <EmptyState title="No lead sources yet" body="Add a source under Settings › Lead sources to see where leads come from." />;

  const save = (sourceId: string) => {
    const spend = Number(value.replace(/[, ]/g, ''));
    if (!Number.isFinite(spend) || spend < 0) {
      toast.error('Enter a spend of 0 or more');
      return;
    }
    start(async () => {
      const r = await setSourceSpendAction({ sourceId, month, spend });
      if (r.ok) {
        toast.success(`Spend for ${month} saved`);
        setEditing(null);
      } else toast.error(r.error);
    });
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 text-right font-medium">Leads</th>
            <th className="px-3 py-2 text-right font-medium">Qualified %</th>
            <th className="px-3 py-2 text-right font-medium">Won</th>
            <th className="px-3 py-2 text-right font-medium">Won value</th>
            {showSpend && (
              <>
                <th className="px-3 py-2 text-right font-medium">Spend</th>
                <th className="px-3 py-2 text-right font-medium">Cost / lead</th>
                <th className="px-3 py-2 text-right font-medium">Cost / won</th>
                <th className="px-3 py-2 text-right font-medium">ROI</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sourceId ?? 'none'} className="border-t border-slate-100">
              <td className="px-3 py-2 font-medium text-slate-900">{r.name}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.leads.toLocaleString('en-IN')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt('percent', r.qualifiedPct, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.won}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt('currency', r.wonValue, currency)}</td>
              {showSpend && (
                <>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.sourceId && canEditSpend && editing === r.sourceId ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          autoFocus
                          inputMode="decimal"
                          aria-label={`Spend for ${r.name} in ${month}`}
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') save(r.sourceId!);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          className="w-24 rounded border border-slate-300 px-1.5 py-0.5 text-right"
                        />
                        <button type="button" disabled={pending} onClick={() => save(r.sourceId!)} className="rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-white">
                          Save
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!r.sourceId || !canEditSpend}
                        onClick={() => {
                          setEditing(r.sourceId);
                          setValue('');
                        }}
                        className="rounded px-1 hover:bg-slate-100 disabled:hover:bg-transparent"
                        title={r.sourceId && canEditSpend ? `Set spend for ${month}` : undefined}
                      >
                        {fmt('currency', r.spend, currency)}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt('currency', r.costPerLead, currency)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt('currency', r.costPerWon, currency)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt('ratio', r.roi, currency)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
