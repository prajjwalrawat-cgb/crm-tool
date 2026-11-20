'use client';

import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  bpsToPercent,
  formatInr,
  GST_SLABS_BPS,
  isGstSlab,
  newEditorItem,
  percentToBps,
  type EditorDiscount,
  type EditorItem,
} from '@/lib/quotes/editor-form';
import type { QuoteTotals } from '@/lib/quotes/totals';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../../settings/lead-capture/_components/ui';
import { FieldErrors, errorCls } from './section-content-editor';

export type OfferingChoice = { id: string; name: string; active: boolean };

const cellCls = cn(inputCls, 'px-2 py-1.5 text-[12.5px]');
const OTHER = 'other';

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-0.5', className)}>
      <span className="block text-[10.5px] font-medium uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">{label}</span>
      {children}
    </label>
  );
}

export function LineItemsTable({
  items,
  onChange,
  overallDiscount,
  onOverallDiscountChange,
  totals,
  groupByLabel,
  offerings,
  errors,
  readOnly,
  newKey,
}: {
  items: EditorItem[];
  onChange: (items: EditorItem[]) => void;
  overallDiscount: EditorDiscount;
  onOverallDiscountChange: (d: EditorDiscount) => void;
  /** Client-side display totals; null while a number can't be parsed. */
  totals: QuoteTotals | null;
  groupByLabel: boolean;
  offerings: OfferingChoice[];
  errors: Record<string, string[]>;
  readOnly: boolean;
  newKey: () => string;
}) {
  const patch = (i: number, p: Partial<EditorItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...p } : it)));
  const err = (i: number, field: string) => errors[`items.${i}.${field}`];

  return (
    <div className="space-y-3">
      <FieldErrors messages={errors.items} />
      <ol className="space-y-2">
        {items.map((it, i) => {
          const line = totals?.lines[i];
          const slab = !it.taxCustom && isGstSlab(percentToBps(it.taxRate)) ? String(percentToBps(it.taxRate)) : OTHER;
          // Retired offerings stay selectable only on the rows that already carry them.
          const offeringChoices = offerings.filter((o) => o.active || o.id === it.offeringId);
          return (
            <li key={it.key} className="rounded-lg border border-slate-200 p-3 dark:border-[#262626]">
              <div className="flex items-start gap-2">
                <span className="pt-2 text-[12px] tabular-nums text-slate-400">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <textarea
                    aria-label={`Line ${i + 1} description`}
                    rows={2}
                    className={cn(cellCls, 'resize-y', errorCls(err(i, 'description')))}
                    value={it.description}
                    placeholder="Description"
                    readOnly={readOnly}
                    onChange={(e) => patch(i, { description: e.target.value })}
                  />
                  <FieldErrors messages={err(i, 'description')} />
                </div>
                <div className="w-28 shrink-0 pt-2 text-right text-[12.5px] font-medium tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                  {line ? formatInr(line.amountMinor) : '—'}
                </div>
                {readOnly ? null : (
                  <Button
                    variant="ghost"
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => onChange(items.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 pl-5 sm:grid-cols-3 lg:grid-cols-6">
                <Cell label="HSN/SAC">
                  <input className={cellCls} value={it.hsnSac} readOnly={readOnly} onChange={(e) => patch(i, { hsnSac: e.target.value })} />
                </Cell>
                <Cell label="Unit">
                  <input className={cellCls} value={it.unit} placeholder="Nos" readOnly={readOnly} onChange={(e) => patch(i, { unit: e.target.value })} />
                </Cell>
                <Cell label="Qty">
                  <input
                    inputMode="decimal"
                    className={cn(cellCls, 'text-right', errorCls(err(i, 'quantity')))}
                    value={it.quantity}
                    readOnly={readOnly}
                    onChange={(e) => patch(i, { quantity: e.target.value })}
                  />
                </Cell>
                <Cell label="Rate (₹)">
                  <input
                    inputMode="decimal"
                    className={cn(cellCls, 'text-right', errorCls(err(i, 'rateMinor')))}
                    value={it.rate}
                    placeholder="0.00"
                    readOnly={readOnly}
                    onChange={(e) => patch(i, { rate: e.target.value })}
                  />
                </Cell>
                <Cell label="Discount %">
                  <input
                    inputMode="decimal"
                    className={cn(cellCls, 'text-right', errorCls(err(i, 'discountBps')))}
                    value={it.discount}
                    readOnly={readOnly}
                    onChange={(e) => patch(i, { discount: e.target.value })}
                  />
                </Cell>
                <Cell label="GST %">
                  <div className="flex gap-1">
                    <select
                      aria-label={`Line ${i + 1} GST rate`}
                      className={cn(cellCls, errorCls(err(i, 'taxRateBps')))}
                      value={slab}
                      disabled={readOnly}
                      onChange={(e) =>
                        e.target.value === OTHER
                          ? patch(i, { taxCustom: true })
                          : patch(i, { taxCustom: false, taxRate: bpsToPercent(Number(e.target.value)) })
                      }
                    >
                      {GST_SLABS_BPS.map((b) => (
                        <option key={b} value={b}>
                          {bpsToPercent(b)}%
                        </option>
                      ))}
                      <option value={OTHER}>Other</option>
                    </select>
                    {slab === OTHER ? (
                      <input
                        aria-label={`Line ${i + 1} GST percent`}
                        inputMode="decimal"
                        className={cn(cellCls, 'w-16 text-right', errorCls(err(i, 'taxRateBps')))}
                        value={it.taxRate}
                        readOnly={readOnly}
                        onChange={(e) => patch(i, { taxRate: e.target.value })}
                      />
                    ) : null}
                  </div>
                </Cell>
              </div>

              {offerings.length > 0 || groupByLabel ? (
                <div className="mt-2 grid grid-cols-1 gap-2 pl-5 sm:grid-cols-2">
                  {offerings.length > 0 ? (
                    <Cell label="Offering (optional)">
                      <select
                        className={cellCls}
                        value={it.offeringId}
                        disabled={readOnly}
                        onChange={(e) => patch(i, { offeringId: e.target.value })}
                      >
                        <option value="">None</option>
                        {offeringChoices.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.active ? o.name : `${o.name} (retired)`}
                          </option>
                        ))}
                      </select>
                    </Cell>
                  ) : null}
                  {groupByLabel ? (
                    <Cell label="Group">
                      <input
                        className={cellCls}
                        value={it.groupLabel}
                        placeholder="e.g. Hardware"
                        readOnly={readOnly}
                        onChange={(e) => patch(i, { groupLabel: e.target.value })}
                      />
                    </Cell>
                  ) : null}
                </div>
              ) : null}
              <div className="pl-5">
                {(['quantity', 'rateMinor', 'discountBps', 'taxRateBps', 'offeringId', 'groupLabel'] as const).map((f) => (
                  <FieldErrors key={f} messages={err(i, f)} />
                ))}
              </div>
            </li>
          );
        })}
      </ol>

      {readOnly ? null : (
        <Button onClick={() => onChange([...items, newEditorItem(newKey())])}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
        </Button>
      )}

      <OverallDiscountControl value={overallDiscount} onChange={onOverallDiscountChange} readOnly={readOnly} errors={errors.overallDiscount} />

      <TotalsSummary totals={totals} />
    </div>
  );
}

const DISCOUNT_CHOICES: { type: EditorDiscount['type']; label: string }[] = [
  { type: 'none', label: 'None' },
  { type: 'amount', label: '₹' },
  { type: 'percent', label: '%' },
];

function OverallDiscountControl({
  value,
  onChange,
  readOnly,
  errors,
}: {
  value: EditorDiscount;
  onChange: (d: EditorDiscount) => void;
  readOnly: boolean;
  errors?: string[];
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Overall discount</span>
        <div role="radiogroup" aria-label="Overall discount type" className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-[#2A2A2A]">
          {DISCOUNT_CHOICES.map((c) => (
            <button
              key={c.type}
              type="button"
              role="radio"
              aria-checked={value.type === c.type}
              disabled={readOnly}
              onClick={() => onChange({ type: c.type, value: c.type === value.type ? value.value : '' })}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition disabled:cursor-not-allowed',
                value.type === c.type
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-[#181818]',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {value.type !== 'none' ? (
          <input
            aria-label={value.type === 'amount' ? 'Overall discount in rupees' : 'Overall discount percent'}
            inputMode="decimal"
            className={cn(cellCls, 'w-32 text-right', errorCls(errors))}
            value={value.value}
            placeholder={value.type === 'amount' ? '0.00' : '0'}
            readOnly={readOnly}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
          />
        ) : null}
      </div>
      <FieldErrors messages={errors} />
    </div>
  );
}

function TotalsSummary({ totals }: { totals: QuoteTotals | null }) {
  if (!totals) {
    return (
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
        Totals appear once every quantity, rate and percentage is a valid number and the discount does not exceed the
        subtotal.
      </p>
    );
  }
  const rows: [string, number][] = [['Subtotal', totals.subtotalMinor]];
  if (totals.lineDiscountMinor) rows.push(['Line discounts', -totals.lineDiscountMinor]);
  if (totals.overallDiscountMinor) rows.push(['Overall discount', -totals.overallDiscountMinor]);
  rows.push(['Taxable value', totals.taxableMinor]);
  for (const g of totals.taxGroups) rows.push([`GST @ ${bpsToPercent(g.rateBps)}%`, g.taxMinor]);
  return (
    <dl className="ml-auto max-w-xs space-y-1 text-[12.5px]">
      {rows.map(([label, minor]) => (
        <div key={label} className="flex justify-between gap-4 text-slate-600 dark:text-[#A1A1AA]">
          <dt>{label}</dt>
          <dd className="tabular-nums">{formatInr(minor)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-4 border-t border-slate-200 pt-1 font-semibold text-slate-900 dark:border-[#262626] dark:text-[#FAFAFA]">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatInr(totals.totalMinor)}</dd>
      </div>
    </dl>
  );
}
