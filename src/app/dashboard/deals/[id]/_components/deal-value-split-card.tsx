'use client';

import { CalendarRange, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { saveDealValueSplitAction } from '@/app/dashboard/deals/[id]/value-split-actions';
import { formatCurrency } from '@/lib/deals/currency';
import {
  BILLING_TYPE_LABELS,
  BILLING_TYPES,
  type BillingType,
  componentDisplayName,
  contractYearPeriods,
  elementsToRows,
  generateElementAmounts,
  MAX_CONTRACT_YEARS,
  MAX_ELEMENTS,
  rowsToElements,
  type SplitElement,
  type SplitRow,
  sumSplit,
  VALUE_COMPONENT_LABELS,
  VALUE_COMPONENTS,
  type ValueComponent,
  validateSplit,
} from '@/lib/deals/value-split';
import { cn } from '@/lib/utils';

/**
 * Contract value breakdown. The deal carries one Amount — the TCV — and this
 * records what it is made of and when it falls.
 *
 * Two dimensions: elements (licence, implementation, AMC, …) down the side and
 * contract years across the top. Picking an element's billing type seeds its
 * years — one-time lands in year 1, recurring spreads across the term — and
 * every cell stays editable afterwards, because real contracts have exceptions.
 *
 * The grid must add up to the deal Amount: it describes that money, so a total
 * that disagrees with it would be a claim about revenue that isn't on the deal.
 * The running total shows the gap live and save is blocked until it balances.
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

/** Edit-time element: amounts are strings so a half-typed number survives. */
type DraftElement = {
  elementIndex: number;
  component: ValueComponent;
  componentLabel: string;
  billingType: BillingType;
  amountsMajor: string[];
};

function toDraft(elements: SplitElement[]): DraftElement[] {
  return elements.map((el) => ({
    elementIndex: el.elementIndex,
    component: el.component,
    componentLabel: el.componentLabel ?? '',
    billingType: el.billingType,
    amountsMajor: el.amountsMinor.map(toMajor),
  }));
}

function draftToElements(drafts: DraftElement[]): SplitElement[] {
  return drafts.map((d) => ({
    elementIndex: d.elementIndex,
    component: d.component,
    componentLabel: d.component === 'other' ? d.componentLabel : null,
    billingType: d.billingType,
    amountsMinor: d.amountsMajor.map(toMinor),
  }));
}

function draftTotal(d: DraftElement): number {
  return d.amountsMajor.reduce((acc, v) => acc + toMinor(v), 0);
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
  /** The deal's TCV. The breakdown must sum to exactly this. */
  amountMinor: number;
  currency: string;
  /** Seeds the contract start when there's no breakdown yet. */
  expectedCloseDate: string | null;
  initialRows: SplitRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [elements, setElements] = useState<DraftElement[]>(() =>
    toDraft(rowsToElements(initialRows)),
  );
  const [startISO, setStartISO] = useState(
    () => initialRows[0]?.periodStart ?? expectedCloseDate ?? '',
  );

  const initialElements = rowsToElements(initialRows);
  const initialTerm = new Set(initialRows.map((r) => r.yearIndex)).size;

  // Adopt the server's rows on a fresh render while idle.
  const serverKey = initialRows
    .map((r) => `${r.elementIndex}:${r.yearIndex}:${r.periodStart}:${r.amountMinor}`)
    .join('|');
  const [syncedKey, setSyncedKey] = useState(serverKey);
  if (syncedKey !== serverKey && !editing) {
    setSyncedKey(serverKey);
    setElements(toDraft(rowsToElements(initialRows)));
    setStartISO(initialRows[0]?.periodStart ?? expectedCloseDate ?? '');
  }

  // Term is however many year columns the grid currently has.
  const term = elements[0]?.amountsMajor.length ?? 0;
  const periods = startISO && term > 0 ? contractYearPeriods(startISO, term) : [];

  const draftRows: SplitRow[] =
    startISO && term > 0
      ? elementsToRows(draftToElements(elements), startISO, term)
      : [];
  const total = sumSplit(draftRows);
  const difference = amountMinor - total;
  const check = draftRows.length > 0 ? validateSplit(draftRows, amountMinor) : null;

  /**
   * Change the term. Each element keeps its own total and re-spreads it over
   * the new number of years according to its billing type — resizing the grid
   * shouldn't silently change what the contract is worth.
   */
  function setTerm(nextTerm: number) {
    if (nextTerm < 1 || nextTerm > MAX_CONTRACT_YEARS) return;
    if (elements.length === 0) {
      // First element carries the whole deal so the grid starts balanced.
      setElements([
        {
          elementIndex: 1,
          component: 'license',
          componentLabel: '',
          billingType: 'recurring',
          amountsMajor: generateElementAmounts(
            'recurring',
            nextTerm,
            amountMinor,
          ).map(toMajor),
        },
      ]);
      return;
    }
    setElements(
      elements.map((el) => ({
        ...el,
        amountsMajor: generateElementAmounts(
          el.billingType,
          nextTerm,
          draftTotal(el),
        ).map(toMajor),
      })),
    );
  }

  /** Re-seed one element's years from its current total. */
  function setBillingType(i: number, billingType: BillingType) {
    const next = elements.slice();
    const el = next[i]!;
    next[i] = {
      ...el,
      billingType,
      amountsMajor: generateElementAmounts(
        billingType,
        el.amountsMajor.length,
        draftTotal(el),
      ).map(toMajor),
    };
    setElements(next);
  }

  function addElement() {
    if (elements.length >= MAX_ELEMENTS || term === 0) return;
    setElements([
      ...elements,
      {
        elementIndex: elements.length + 1,
        component: 'amc',
        componentLabel: '',
        billingType: 'recurring',
        // Starts empty: the author decides what to move into it, and the
        // running total tells them when the grid balances again.
        amountsMajor: Array.from({ length: term }, () => '0.00'),
      },
    ]);
  }

  function removeElement(i: number) {
    // Element index is positional identity, so renumber after a removal to
    // keep the 1..n-with-no-gaps rule the validator enforces.
    setElements(
      elements
        .filter((_, idx) => idx !== i)
        .map((el, idx) => ({ ...el, elementIndex: idx + 1 })),
    );
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
        result.cleared ? 'Contract breakdown removed.' : 'Contract breakdown saved.',
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
              {initialElements.length}{' '}
              {initialElements.length === 1 ? 'element' : 'elements'} ·{' '}
              {initialTerm} {initialTerm === 1 ? 'year' : 'years'}
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
            {hasSplit ? 'Edit breakdown' : 'Add breakdown'}
          </button>
        ) : null}
      </header>

      {!editing ? (
        hasSplit ? (
          <>
            {/* Wide grids scroll inside the card rather than the page. */}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-lg text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="pb-1 pr-3 font-medium">Element</th>
                    <th className="pb-1 pr-3 font-medium">Type</th>
                    {Array.from({ length: initialTerm }, (_, i) => (
                      <th key={i} className="pb-1 pl-3 text-right font-medium">
                        Yr {i + 1}
                      </th>
                    ))}
                    <th className="pb-1 pl-3 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {initialElements.map((el) => (
                    <tr
                      key={el.elementIndex}
                      className="border-t border-slate-100 dark:border-[#1F1F1F]"
                    >
                      <td className="py-1.5 pr-3 text-slate-700 dark:text-[#FAFAFA]">
                        {componentDisplayName(el.component, el.componentLabel)}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500">
                        {BILLING_TYPE_LABELS[el.billingType]}
                      </td>
                      {el.amountsMinor.map((minor, i) => (
                        <td
                          key={i}
                          className={cn(
                            'py-1.5 pl-3 text-right font-mono',
                            minor === 0
                              ? 'text-slate-300 dark:text-[#3F3F46]'
                              : 'text-slate-900 dark:text-[#FAFAFA]',
                          )}
                        >
                          {minor === 0 ? '—' : formatCurrency(minor, currency)}
                        </td>
                      ))}
                      <td className="py-1.5 pl-3 text-right font-mono font-medium text-slate-900 dark:text-[#FAFAFA]">
                        {formatCurrency(
                          el.amountsMinor.reduce((a, b) => a + b, 0),
                          currency,
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 dark:border-[#1F1F1F]">
                    <td
                      className="pt-1.5 pr-3 font-medium text-slate-700 dark:text-[#A1A1AA]"
                      colSpan={2}
                    >
                      Total contract value
                    </td>
                    {Array.from({ length: initialTerm }, (_, i) => (
                      <td
                        key={i}
                        className="pt-1.5 pl-3 text-right font-mono text-slate-600 dark:text-[#A1A1AA]"
                      >
                        {formatCurrency(
                          initialElements.reduce(
                            (acc, el) => acc + (el.amountsMinor[i] ?? 0),
                            0,
                          ),
                          currency,
                        )}
                      </td>
                    ))}
                    <td className="pt-1.5 pl-3 text-right font-mono font-semibold text-slate-900 dark:text-[#FAFAFA]">
                      {formatCurrency(sumSplit(initialRows), currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {initialRows.length > 0 ? (
              <p className="mt-2 text-[11px] leading-tight text-slate-400">
                {fmtPeriod(
                  initialRows[0]!.periodStart,
                  initialRows.find((r) => r.yearIndex === initialTerm)?.periodEnd ??
                    initialRows[0]!.periodEnd,
                )}{' '}
                · Reporting only — the deal still counts once, at its full
                amount, on the board and in the forecast.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
            {formatCurrency(amountMinor, currency)} is recorded as a single
            value.{' '}
            {canEdit
              ? 'Add a breakdown to record what it is made of and when it falls.'
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
                onChange={(e) => setStartISO(e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111]"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Term (years)
              </span>
              <select
                value={term || ''}
                onChange={(e) => setTerm(Number(e.target.value))}
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
            <p className="text-[11px] text-slate-400">
              {startISO
                ? 'One-time lands in year 1, recurring spreads across the term — edit any cell after.'
                : 'Pick a contract start to build the grid.'}
            </p>
          </div>

          {term > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-2xl text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="pb-1 pr-2 font-medium">Element</th>
                    <th className="pb-1 pr-2 font-medium">Type</th>
                    {periods.map((p) => (
                      <th key={p.yearIndex} className="pb-1 pl-2 text-right font-medium">
                        <span title={fmtPeriod(p.periodStart, p.periodEnd)}>
                          Yr {p.yearIndex}
                        </span>
                      </th>
                    ))}
                    <th className="pb-1 pl-2 text-right font-medium">Total</th>
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {elements.map((el, i) => (
                    <tr
                      key={el.elementIndex}
                      className="border-t border-slate-100 dark:border-[#1F1F1F]"
                    >
                      <td className="py-1 pr-2">
                        <div className="flex flex-col gap-1">
                          <select
                            value={el.component}
                            onChange={(e) => {
                              const next = elements.slice();
                              next[i] = {
                                ...el,
                                component: e.target.value as ValueComponent,
                              };
                              setElements(next);
                            }}
                            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111]"
                          >
                            {VALUE_COMPONENTS.map((c) => (
                              <option key={c} value={c}>
                                {VALUE_COMPONENT_LABELS[c]}
                              </option>
                            ))}
                          </select>
                          {el.component === 'other' ? (
                            <input
                              type="text"
                              value={el.componentLabel}
                              maxLength={60}
                              placeholder="Name this element"
                              onChange={(e) => {
                                const next = elements.slice();
                                next[i] = { ...el, componentLabel: e.target.value };
                                setElements(next);
                              }}
                              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-[#1F1F1F] dark:bg-[#111111]"
                            />
                          ) : null}
                        </div>
                      </td>
                      <td className="py-1 pr-2 align-top">
                        <select
                          value={el.billingType}
                          onChange={(e) =>
                            setBillingType(i, e.target.value as BillingType)
                          }
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111]"
                        >
                          {BILLING_TYPES.map((b) => (
                            <option key={b} value={b}>
                              {BILLING_TYPE_LABELS[b]}
                            </option>
                          ))}
                        </select>
                      </td>
                      {el.amountsMajor.map((v, y) => (
                        <td key={y} className="py-1 pl-2 align-top">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={v}
                            aria-label={`${componentDisplayName(el.component, el.componentLabel)} year ${y + 1}`}
                            onChange={(e) => {
                              const next = elements.slice();
                              const amounts = el.amountsMajor.slice();
                              amounts[y] = e.target.value;
                              next[i] = { ...el, amountsMajor: amounts };
                              setElements(next);
                            }}
                            className="w-28 rounded-md border border-slate-200 bg-white px-2 py-1 text-right font-mono text-[13px] dark:border-[#1F1F1F] dark:bg-[#111111]"
                          />
                        </td>
                      ))}
                      <td className="py-1 pl-2 text-right align-top font-mono text-[13px] text-slate-700 dark:text-[#A1A1AA]">
                        <span className="inline-block py-1">
                          {formatCurrency(draftTotal(el), currency)}
                        </span>
                      </td>
                      <td className="py-1 pl-1 align-top">
                        <button
                          type="button"
                          onClick={() => removeElement(i)}
                          disabled={elements.length <= 1}
                          title={
                            elements.length <= 1
                              ? 'A breakdown needs at least one element'
                              : 'Remove this element'
                          }
                          className="rounded p-1 text-slate-400 hover:bg-slate-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-slate-800/60"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 dark:border-[#1F1F1F]">
                    <td
                      className="pt-1.5 pr-2 text-[12px] font-medium text-slate-600 dark:text-[#A1A1AA]"
                      colSpan={2}
                    >
                      Per year
                    </td>
                    {periods.map((p, y) => (
                      <td
                        key={p.yearIndex}
                        className="pt-1.5 pl-2 text-right font-mono text-[12px] text-slate-600 dark:text-[#A1A1AA]"
                      >
                        {formatCurrency(
                          elements.reduce(
                            (acc, el) => acc + toMinor(el.amountsMajor[y] ?? '0'),
                            0,
                          ),
                          currency,
                        )}
                      </td>
                    ))}
                    <td className="pt-1.5 pl-2 text-right font-mono text-[12px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                      {formatCurrency(total, currency)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}

          {term > 0 ? (
            <div>
              <button
                type="button"
                onClick={addElement}
                disabled={elements.length >= MAX_ELEMENTS}
                className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-[#1F1F1F] dark:text-[#A1A1AA]"
              >
                <Plus className="h-3 w-3" aria-hidden />
                Add element
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
              Breakdown total{' '}
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

          {check && !check.ok && difference === 0 ? (
            <p className="text-[12px] text-amber-700">{check.message}</p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {hasSplit ? (
              <button
                type="button"
                onClick={() => save([])}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1 text-[12.5px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Remove breakdown
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setElements(toDraft(rowsToElements(initialRows)));
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
                disabled={pending || draftRows.length === 0 || check?.ok !== true}
                title={
                  check && !check.ok
                    ? check.message
                    : 'Save the contract breakdown'
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : null}
                Save breakdown
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
