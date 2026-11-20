'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';

import { Button } from '../../../lead-capture/_components/ui';
import { Field, inputCls, ToggleRow, type SectionFormProps } from './controls';

const COLUMN_NAMES: Record<string, string> = {
  sno: 'Serial number',
  description: 'Description',
  hsn_sac: 'HSN/SAC',
  unit: 'Unit',
  quantity: 'Quantity',
  rate: 'Rate',
  discount: 'Discount',
  tax_rate: 'GST rate',
  amount: 'Amount',
};

/** Always printed (the schema rejects hiding them). */
const REQUIRED = new Set(['description', 'amount']);

export function LineItemsSettings({ section, onChange }: SectionFormProps<'line_items'>) {
  const s = section.settings;
  const cols = s.columns;
  const setCols = (next: typeof cols) => onChange({ ...s, columns: next });
  const patch = (i: number, p: Partial<(typeof cols)[number]>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    const next = [...cols];
    [next[i], next[j]] = [next[j], next[i]];
    setCols(next);
  };

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
        Every quote has exactly one items table; it can be moved but not removed or hidden.
      </p>
      <Field label="Columns" hint="Order, heading and visibility of each column.">
        <div className="space-y-1.5">
          {cols.map((c, i) => (
            <div key={c.key} className="flex items-center gap-2">
              <label className="flex w-36 shrink-0 items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-[#D4D4D8]">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-600"
                  checked={c.visible}
                  disabled={REQUIRED.has(c.key)}
                  onChange={(e) => patch(i, { visible: e.target.checked })}
                />
                {COLUMN_NAMES[c.key] ?? c.key}
              </label>
              <input
                aria-label={`${COLUMN_NAMES[c.key] ?? c.key} heading`}
                className={inputCls}
                value={c.label}
                onChange={(e) => patch(i, { label: e.target.value })}
              />
              <Button variant="ghost" aria-label={`Move ${c.key} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button variant="ghost" aria-label={`Move ${c.key} down`} disabled={i === cols.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </Field>
      <ToggleRow
        label="Group items by their group label"
        hint="Items with the same group label print under a shared sub-heading."
        checked={s.groupByLabel}
        onChange={(v) => onChange({ ...s, groupByLabel: v })}
      />
    </div>
  );
}
