'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { fmt, type CurrencyCtx } from '@/lib/reports/manager/format';

import { listAssignableAction, nudgeOwnerAction, reassignFromReportAction } from '../actions';
import { EmptyState } from './ui';

type Stale = { dealId: string; name: string; stage: string; ownerId: string | null; ownerName: string; value: number; lastActivityAt: string; idleDays: number };

export function ReassignButton({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Array<{ id: string; name: string }> | null>(null);
  const [pending, start] = useTransition();
  return open ? (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label="Reassign to"
        autoFocus
        disabled={!people || pending}
        defaultValue=""
        onChange={(e) => {
          const to = e.target.value;
          if (!to) return;
          start(async () => {
            const r = await reassignFromReportAction(dealId, to);
            if (r.ok) toast.success('Reassigned');
            else toast.error(r.error);
            setOpen(false);
          });
        }}
        className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[12px]"
      >
        <option value="">{people ? 'Choose…' : 'Loading…'}</option>
        {people?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-slate-500">
        Cancel
      </button>
    </span>
  ) : (
    <button
      type="button"
      onClick={() => {
        setOpen(true);
        listAssignableAction().then(setPeople).catch(() => toast.error('Could not load team'));
      }}
      className="rounded border border-slate-300 px-1.5 py-0.5 text-[11.5px] text-slate-700 hover:bg-slate-50"
    >
      Reassign
    </button>
  );
}

function NudgeButton({ dealId }: { dealId: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      disabled={pending || done}
      onClick={() =>
        start(async () => {
          const r = await nudgeOwnerAction(dealId);
          if (r.ok) {
            setDone(true);
            toast.success('Owner nudged');
          } else toast.error(r.error);
        })
      }
      className="rounded border border-slate-300 px-1.5 py-0.5 text-[11.5px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
    >
      {done ? 'Nudged' : 'Nudge'}
    </button>
  );
}

export function StaleTable({ rows, days, currency, canReassign }: { rows: Stale[]; days: number; currency: CurrencyCtx; canReassign: boolean }) {
  if (rows.length === 0) return <EmptyState title={`Nothing has gone quiet for more than ${days} days`} />;
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 font-medium">Deal</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium">Owner</th>
            <th className="px-3 py-2 text-right font-medium">Value</th>
            <th className="px-3 py-2 text-right font-medium">Idle</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.dealId} className="border-t border-slate-100">
              <td className="px-3 py-2">
                <Link href={`/dashboard/deals/${r.dealId}`} className="font-medium text-slate-900 hover:underline">
                  {r.name}
                </Link>
              </td>
              <td className="px-3 py-2 capitalize text-slate-700">{r.stage}</td>
              <td className="px-3 py-2 text-slate-700">{r.ownerName}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt('currency', r.value, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.idleDays} d</td>
              <td className="space-x-1 whitespace-nowrap px-3 py-2 text-right">
                {r.ownerId && <NudgeButton dealId={r.dealId} />}
                {canReassign && <ReassignButton dealId={r.dealId} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
