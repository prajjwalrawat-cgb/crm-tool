'use client';

import { Check, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { upsertSalesTargetAction } from '../actions';

type Row = {
  userId: string;
  displayName: string;
  role: string | null;
  revenue: string;
  margin: string;
};

export function TargetsManager({
  fiscalYear,
  fiscalYearLabel,
  choices,
  currency,
  rows: initialRows,
}: {
  fiscalYear: number;
  fiscalYearLabel: string;
  choices: { value: number; label: string }[];
  currency: string;
  rows: Row[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initialRows);

  function setField(userId: string, field: 'revenue' | 'margin', value: string) {
    setRows((rs) =>
      rs.map((r) => (r.userId === userId ? { ...r, [field]: value } : r)),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-[12px] font-medium text-slate-600 dark:text-[#A1A1AA]">
          Fiscal year
        </label>
        <select
          value={fiscalYear}
          onChange={(e) => router.push(`?fy=${e.target.value}`)}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-slate-400">({fiscalYearLabel})</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-[#1F1F1F]">
        <table className="w-full text-[13px]">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
            <tr>
              <th className="px-3 py-2 font-medium">Team member</th>
              <th className="px-3 py-2 font-medium">Revenue target ({currency})</th>
              <th className="px-3 py-2 font-medium">Margin target ({currency})</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-6 text-center text-slate-500 dark:text-[#A1A1AA]"
                >
                  No sales team members yet. Invite members from the Team page.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <TargetRow
                  key={r.userId}
                  row={r}
                  fiscalYear={fiscalYear}
                  onChange={setField}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TargetRow({
  row,
  fiscalYear,
  onChange,
}: {
  row: Row;
  fiscalYear: number;
  onChange: (userId: string, field: 'revenue' | 'margin', value: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function save() {
    startTransition(async () => {
      const res = await upsertSalesTargetAction({
        userId: row.userId,
        fiscalYear,
        revenueTarget: Number(row.revenue) || 0,
        marginTarget: Number(row.margin) || 0,
      });
      if (res.ok) {
        setSaved(true);
        toast.success(`Saved target for ${row.displayName}`);
        setTimeout(() => setSaved(false), 2500);
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <tr className="border-t border-slate-100 dark:border-[#1F1F1F]">
      <td className="px-3 py-2">
        <div className="font-medium text-slate-800 dark:text-[#FAFAFA]">
          {row.displayName}
        </div>
        {row.role ? (
          <div className="text-[11px] capitalize text-slate-400">{row.role}</div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min="0"
          step="0.01"
          value={row.revenue}
          onChange={(e) => onChange(row.userId, 'revenue', e.target.value)}
          placeholder="0"
          className="w-36 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min="0"
          step="0.01"
          value={row.margin}
          onChange={(e) => onChange(row.userId, 'margin', e.target.value)}
          placeholder="0"
          className="w-36 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
        />
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : saved ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : null}
          {saved ? 'Saved' : 'Save'}
        </button>
      </td>
    </tr>
  );
}
