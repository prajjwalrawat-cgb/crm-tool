'use client';

import { CalendarRange, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { saveDealValueSplitAction } from '@/app/dashboard/deals/[id]/value-split-actions';
import { formatCurrency } from '@/lib/deals/currency';
import {
  addYearsISO,
  generateContractYears,
  MAX_CONTRACT_YEARS,
  type SplitRow,
  sumSplit,
  validateSplit,
} from '@/lib/deals/value-split';
import { cn } from '@/lib/utils';

/**
 * Multi-year contract value. The deal carries one Amount — the TCV — and this
 * records how it breaks down per contract year.
 *
 * Rows generate from a contract start date + term (year 1 on the start date,
 * each later year on the anniversary) and every amount stays editable, because
 * real contracts are rarely split evenly. The rows must add up to the deal
 * Amount: the split describes that money, so a total that disagrees with it
 * would be a claim about revenue that isn't on the deal. The running total
 * shows the gap live and the save is blocked until it balances.
 */

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
});

function fmtPeriod(startISO: string, endISO: string): string {
  // The stored end is exclusive (the next year's start); show the last day
  // that's actually inside the year.
  const lastDay = new Date(new Date(endISO).getTime() - 86_400_000);
  return `${dateFormatter.format(new Date(startISO))} – ${dateFormatter.format(lastDay)}`;
}

function toMajor(minor: number): string {
  return (minor / 100).toFixed(2);
}
function toMinor(major: string): number {
  const n = Number(major);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

type DraftRow = SplitRow & { amountMajor: string };

function toDraft(rows: SplitRow[]): DraftRow[] {
  return rows.map((r) => ({ ...r, amountMajor: toMajor(r.amountMinor) }));
}

export function DealValueSplitCard({
  dealId,
  amountMinor,
  currency,
  expectedCloseDate,
  initialRows,
  canEdit,
}: {
  dealId: string;
  /** The deal's TCV. The split must sum to exactly this. */
  amountMinor: number;
  currency: string;
  /** Seeds the contract start when there's no split yet. */
  expectedCloseDate: string | null;
  initialRows: SplitRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<DraftRow[]>(() => toDraft(initialRows));
  const [startISO, setStartISO] = useState(
    () => initialRows[0]?.periodStart ?? expectedCloseDate ?? '',
  );

  // Adopt the server's rows on a fresh render while idle.
  const serverKey = initialRows
    .map((r) => `${r.yearIndex}:${r.periodStart}:${r.amountMinor}`)
    .join('|');
  const [syncedKey, setSyncedKey] = useState(serverKey);
  if (syncedKey !== serverKey && !editing) {
    setSyncedKey(serverKey);
    setRows(toDraft(initialRows));
    setStartISO(initialRows[0]?.periodStart ?? expectedCloseDate ?? '');
  }

  const draftRows: SplitRow[] = rows.map((r) => ({
    yearIndex: r.yearIndex,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    amountMinor: toMinor(r.amountMajor),
  }));
  const total = sumSplit(draftRows);
  const difference = amountMinor - total;
  const check = rows.length > 0 ? validateSplit(draftRows, amountMinor) : null;

  function regenerate(nextStart: string, term: number) {
    if (!nextStart) return;
    try {
      setRows(toDraft(generateContractYears(nextStart, term, amountMinor)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the years.');
    }
  }

  function addYear() {
    if (rows.length >= MAX_CONTRACT_YEARS) return;
    const last = rows[rows.length - 1];
    const start = last ? last.periodEnd : startISO;
    if (!start) return;
    setRows([
      ...rows,
      {
        yearIndex: rows.length + 1,
        periodStart: start,
        periodEnd: addYearsISO(start, 1),
        amountMinor: 0,
        amountMajor: '0.00',
      },
    ]);
  }

  function removeLastYear() {
    if (rows.length === 0) return;
    setRows(rows.slice(0, -1));
  }

  function save(nextRows: SplitRow[]) {
    startTransition(async () => {
      const result = await saveDealValueSplitAction({ dealId, rows: nextRows });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setEditing(false);
      toast.success(
        result.cleared ? 'Contract split removed.' : 'Contract split saved.',
      );
      router.refresh();
    });
  }

  const hasSplit = initialRows.length > 0;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
          <CalendarRange className="h-4 w-4 text-slate-400" aria-hidden />
          Contract value split
          {hasSplit && !editing ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-[#1F1F1F] dark:text-[#A1A1AA]">
              {initialRows.length} {initialRows.length === 1 ? 'year' : 'years'}
            </span>
          ) : null}
        </h2>
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#A1A1AA]"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {hasSplit ? 'Edit split' : 'Add split'}
          </button>
        ) : null}
      </header>

      {!editing ? (
        hasSplit ? (
          <>
            <table className="mt-3 w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="pb-1 font-medium">Year</th>
                  <th className="pb-1 font-medium">Period</th>
                  <th className="pb-1 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {initialRows.map((r) => (
                  <tr
                    key={r.yearIndex}
                    className="border-t border-slate-100 dark:border-[#1F1F1F]"
                  >
                    <td className="py-1.5 text-slate-600">Year {r.yearIndex}</td>
                    <td className="py-1.5 text-slate-500">
                      {fmtPeriod(r.periodStart, r.periodEnd)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-slate-900 dark:text-[#FAFAFA]">
                      {formatCurrency(r.amountMinor, currency)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 dark:border-[#1F1F1F]">
                  <td className="pt-1.5 font-medium text-slate-700" colSpan={2}>
                    Total contract value
                  </td>
                  <td className="pt-1.5 text-right font-mono font-semibold text-slate-900 dark:text-[#FAFAFA]">
                    {formatCurrency(sumSplit(initialRows), currency)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-tight text-slate-400">
              Reporting only — the deal still counts once, at its full amount,
              on the board and in the forecast.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
            {formatCurrency(amountMinor, currency)} is recorded as a single
            value.{' '}
            {canEdit
              ? 'Add a split if this contract runs across multiple years.'
              : null}
          </p>
        )
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Contract start
              </span>
              <input
                type="date"
                value={startISO}
                onChange={(e) => {
                  setStartISO(e.target.value);
                  if (rows.length > 0) regenerate(e.target.value, rows.length);
                }}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111]"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Term (years)
              </span>
              <select
                value={rows.length || ''}
                onChange={(e) => regenerate(startISO, Number(e.target.value))}
                disabled={!startISO}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] disabled:opacity-50 dark:border-[#1F1F1F] dark:bg-[#111111]"
              >
                <option value="">—</option>
                {Array.from({ length: MAX_CONTRACT_YEARS }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ),
                )}
              </select>
            </label>
            {startISO ? (
              <p className="text-[11px] text-slate-400">
                Years split evenly to start — edit any amount below.
              </p>
            ) : (
              <p className="text-[11px] text-slate-400">
                Pick a contract start to generate the years.
              </p>
            )}
          </div>

          {rows.length > 0 ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="pb-1 font-medium">Year</th>
                  <th className="pb-1 font-medium">Period</th>
                  <th className="pb-1 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.yearIndex}
                    className="border-t border-slate-100 dark:border-[#1F1F1F]"
                  >
                    <td className="py-1 text-slate-600">Year {r.yearIndex}</td>
                    <td className="py-1 text-slate-500">
                      {fmtPeriod(r.periodStart, r.periodEnd)}
                    </td>
                    <td className="py-1 text-right">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={r.amountMajor}
                        onChange={(e) => {
                          const next = rows.slice();
                          next[i] = { ...r, amountMajor: e.target.value };
                          setRows(next);
                        }}
                        className="w-32 rounded-md border border-slate-200 bg-white px-2 py-1 text-right font-mono text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111]"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {rows.length > 0 ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addYear}
                disabled={rows.length >= MAX_CONTRACT_YEARS}
                className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <Plus className="h-3 w-3" aria-hidden />
                Add year
              </button>
              <button
                type="button"
                onClick={removeLastYear}
                className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
              >
                <X className="h-3 w-3" aria-hidden />
                Remove last
              </button>
            </div>
          ) : null}

          {/* The running total is the whole point of the rule — show the gap
              as it's typed rather than only on a rejected save. */}
          <div
            className={cn(
              'flex items-center justify-between rounded-md px-3 py-2 text-[13px]',
              difference === 0
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-amber-50 text-amber-800',
            )}
          >
            <span>
              Split total{' '}
              <span className="font-mono font-medium">
                {formatCurrency(total, currency)}
              </span>{' '}
              of{' '}
              <span className="font-mono font-medium">
                {formatCurrency(amountMinor, currency)}
              </span>
            </span>
            <span className="font-medium">
              {difference === 0
                ? 'Balanced'
                : difference > 0
                  ? `${formatCurrency(difference, currency)} short`
                  : `${formatCurrency(-difference, currency)} over`}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {hasSplit ? (
              <button
                type="button"
                onClick={() => save([])}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1 text-[12.5px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Remove split
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setRows(toDraft(initialRows));
                  setStartISO(
                    initialRows[0]?.periodStart ?? expectedCloseDate ?? '',
                  );
                  setEditing(false);
                }}
                disabled={pending}
                className="rounded-md border border-slate-200 px-2.5 py-1 text-[12.5px] hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => save(draftRows)}
                disabled={pending || rows.length === 0 || check?.ok !== true}
                title={
                  check && !check.ok ? check.message : 'Save the contract split'
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : null}
                Save split
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
