'use client';

import { Field, selectCls, ToggleRow, type SectionFormProps } from './controls';

export function TotalsSettings({ section, onChange }: SectionFormProps<'totals'>) {
  const s = section.settings;
  return (
    <div className="space-y-3">
      <ToggleRow label="Show subtotal" checked={s.showSubtotal} onChange={(v) => onChange({ ...s, showSubtotal: v })} />
      <Field label="Discounts" htmlFor="tot-disc">
        <select
          id="tot-disc"
          className={selectCls}
          value={s.discountDisplay}
          onChange={(e) => onChange({ ...s, discountDisplay: e.target.value as typeof s.discountDisplay })}
        >
          <option value="combined">One discount line</option>
          <option value="split">Line and overall discounts separately</option>
          <option value="hidden">Hidden</option>
        </select>
      </Field>
      <ToggleRow
        label="Show GST breakdown"
        hint="CGST + SGST, or IGST for an out-of-state buyer, per rate."
        checked={s.showTaxBreakdown}
        onChange={(v) => onChange({ ...s, showTaxBreakdown: v })}
      />
      <ToggleRow label="Round off to the nearest rupee" checked={s.showRoundOff} onChange={(v) => onChange({ ...s, showRoundOff: v })} />
      <ToggleRow label="Show amount in words" checked={s.showAmountInWords} onChange={(v) => onChange({ ...s, showAmountInWords: v })} />
    </div>
  );
}
