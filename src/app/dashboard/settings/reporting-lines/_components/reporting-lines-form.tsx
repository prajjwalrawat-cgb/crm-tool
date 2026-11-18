'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { setReportNarrativeAction, setReportsToAction } from '../actions';

type Row = { userId: string; name: string; email: string | null; role: string; reportsTo: string | null };

export function ReportingLinesForm({
  canEdit,
  members,
  narrativeEnabled,
  timezone,
  backfill,
}: {
  canEdit: boolean;
  members: Row[];
  narrativeEnabled: boolean;
  timezone: string;
  backfill: { status: string; daysDone: number; daysTotal: number; fromDay: string; toDay: string } | null;
}) {
  const [rows, setRows] = useState(members);
  const [narrative, setNarrative] = useState(narrativeEnabled);
  const [pending, start] = useTransition();
  const managers = rows.filter((r) => r.role !== 'viewer');

  function change(userId: string, reportsTo: string | null) {
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.userId === userId ? { ...r, reportsTo } : r)));
    start(async () => {
      const res = await setReportsToAction(userId, reportsTo);
      if (!res.ok) {
        setRows(prev);
        toast.error(res.error);
      } else {
        toast.success('Reporting line saved');
      }
    });
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-slate-900">Reporting lines</h2>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          A manager&apos;s Sales reports cover themselves and everyone below them here. A manager with nobody reporting to them sees the
          whole workspace. Reports count days in <span className="font-medium text-slate-700">{timezone}</span> (change it under
          Organization).
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-[13px]">
          <thead className="bg-slate-50 text-left text-[11.5px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Member</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Reports to</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{r.name}</div>
                  {r.email && <div className="text-[11.5px] text-slate-500">{r.email}</div>}
                </td>
                <td className="px-3 py-2 capitalize text-slate-600">{r.role}</td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`${r.name} reports to`}
                    disabled={!canEdit || pending}
                    value={r.reportsTo ?? ''}
                    onChange={(e) => change(r.userId, e.target.value || null)}
                    className="w-full max-w-xs rounded-md border border-slate-300 bg-white px-2 py-1 text-[13px] text-slate-800 disabled:opacity-60"
                  >
                    <option value="">Nobody (top of the line)</option>
                    {managers
                      .filter((m) => m.userId !== r.userId)
                      .map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-[13px] font-semibold text-slate-900">AI narrative</h3>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          The &quot;What changed and why&quot; card on Sales reports. Only aggregate numbers are sent to the AI provider, with reps shown as
          &quot;Rep 1, Rep 2…&quot;. Lead names, phone numbers, emails and notes are never sent. The card is hidden if the AI writes a number
          that isn&apos;t in those aggregates.
        </p>
        <label className="mt-3 flex items-center gap-2 text-[13px] text-slate-800">
          <input
            type="checkbox"
            checked={narrative}
            disabled={!canEdit || pending}
            onChange={(e) => {
              const v = e.target.checked;
              setNarrative(v);
              start(async () => {
                const res = await setReportNarrativeAction(v);
                if (!res.ok) {
                  setNarrative(!v);
                  toast.error(res.error);
                }
              });
            }}
          />
          Show the AI narrative
        </label>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-[13px] font-semibold text-slate-900">Report history</h3>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          {backfill
            ? `Historical rollup ${backfill.fromDay} to ${backfill.toDay}: ${backfill.status}, ${backfill.daysDone} of ${backfill.daysTotal} days.`
            : 'The historical rollup is not built yet. It starts with the first nightly run. Until then reports are computed live: the numbers are the same, just slower.'}
        </p>
      </section>
    </div>
  );
}
