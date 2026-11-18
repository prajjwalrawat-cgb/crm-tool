'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { FunnelStep } from '@/lib/reports/manager/math';
import { cn } from '@/lib/utils';

import { Bone, Card, EmptyState, ErrorBox, VIZ } from './ui';

const STAGE_LABEL: Record<string, string> = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won' };

/**
 * Horizontal cohort funnel. Bars are one hue (magnitude), each labelled
 * with its count, % of cohort and step conversion — the colour never
 * carries meaning on its own. Clicking a bar lists exactly the leads that
 * bar counts (same `maxFunnelRank` rule).
 */
export function FunnelView({ steps, cohortSize, query }: { steps: FunnelStep[]; cohortSize: number; query: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<Array<{ dealId: string; name: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (cohortSize === 0) return <EmptyState title="No leads were created in this period" body="The funnel follows leads created in the selected dates through every stage they reached." />;
  const max = Math.max(1, steps[0]?.count ?? 1);

  const drill = (stage: string) => {
    setOpen(stage);
    setRows(null);
    setErr(null);
    fetch(`/api/reports/funnel?${new URLSearchParams({ ...query, drillStage: stage })}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { rows: Array<{ dealId: string; name: string }> }) => setRows(d.rows))
      .catch((e: Error) => setErr(e.message));
  };

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card title={`Cohort: ${cohortSize.toLocaleString('en-IN')} leads created`} className="lg:col-span-3">
        <ol className={cn('space-y-2.5', VIZ)}>
          {steps.map((s) => (
            <li key={s.stage}>
              <button type="button" onClick={() => drill(s.stage)} className="group w-full text-left" aria-label={`${STAGE_LABEL[s.stage]}: ${s.count} leads. Show them`}>
                <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span className="font-medium text-slate-800">{STAGE_LABEL[s.stage]}</span>
                  <span className="tabular-nums text-slate-600">
                    <span className="font-semibold text-slate-900">{s.count.toLocaleString('en-IN')}</span>
                    {s.cohortPct !== null && <span> · {s.cohortPct}% of cohort</span>}
                    {s.stepConversionPct !== null && <span> · {s.stepConversionPct}% from previous</span>}
                    {s.medianDaysFromPrevious !== null && <span> · median {s.medianDaysFromPrevious} d</span>}
                  </span>
                </div>
                <div className="mt-1 h-6 w-full rounded bg-slate-100">
                  <div
                    className={cn('h-6 rounded bg-[var(--viz-1)] transition-opacity group-hover:opacity-85', open === s.stage && 'ring-2 ring-slate-900 ring-offset-1')}
                    style={{ width: `${Math.max(s.count ? 1.5 : 0, (s.count / max) * 100)}%` }}
                  />
                </div>
              </button>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11.5px] text-slate-500">
          A lead counts at a stage if it ever reached that stage or a later one. Each lead counts once per stage, even if it moved back and forth.
        </p>
      </Card>
      <Card title={open ? `Reached ${STAGE_LABEL[open]}` : 'Leads'} className="lg:col-span-2">
        {!open && <p className="text-[12.5px] text-slate-500">Click a bar to list the leads behind it.</p>}
        {err && <ErrorBox message={`Could not load: ${err}`} />}
        {open && !rows && !err && (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Bone key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {rows && (
          <>
            <p className="mb-2 text-[12px] text-slate-500">{rows.length.toLocaleString('en-IN')} leads (matches the bar)</p>
            <ul className="max-h-96 divide-y divide-slate-100 overflow-auto text-[12.5px]">
              {rows.slice(0, 500).map((r) => (
                <li key={r.dealId} className="py-1">
                  <Link href={`/dashboard/deals/${r.dealId}`} className="text-slate-800 hover:underline">
                    {r.name}
                  </Link>
                </li>
              ))}
            </ul>
            {rows.length > 500 && <p className="mt-2 text-[11.5px] text-slate-500">First 500 shown.</p>}
          </>
        )}
      </Card>
    </div>
  );
}
