'use client';

import { CheckboxGroup, Field, inputCls, NumberInput, selectCls, type SectionFormProps } from './controls';

export const SELLER_FIELDS = [
  { key: 'gstin', label: 'GSTIN' },
  { key: 'pan', label: 'PAN' },
  { key: 'address', label: 'Address' },
  // 'email' / 'phone' are still accepted by the schema (older templates) but
  // not offered: the seller snapshot carries neither, so they never print.
] as const;

const META_FIELDS = [
  { key: 'number', label: 'Quote number' },
  { key: 'date', label: 'Date' },
  { key: 'valid_until', label: 'Valid until' },
  { key: 'rep', label: 'Sales rep' },
] as const;

export function HeaderSettings({ section, onChange }: SectionFormProps<'header'>) {
  const s = section.settings;
  return (
    <div className="space-y-3">
      <Field label="Document title" htmlFor="hdr-title">
        <input id="hdr-title" className={inputCls} value={s.titleText} onChange={(e) => onChange({ ...s, titleText: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Logo position" htmlFor="hdr-logo-pos">
          <select
            id="hdr-logo-pos"
            className={selectCls}
            value={s.logoPosition}
            onChange={(e) => onChange({ ...s, logoPosition: e.target.value as typeof s.logoPosition })}
          >
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </Field>
        <Field label="Logo height (mm)" htmlFor="hdr-logo-h" hint="8 to 40">
          <NumberInput id="hdr-logo-h" min={8} max={40} value={s.logoHeightMm} onChange={(v) => onChange({ ...s, logoHeightMm: v })} />
        </Field>
      </div>
      <Field label="Seller details">
        <CheckboxGroup options={SELLER_FIELDS} value={s.showSellerFields} onChange={(v) => onChange({ ...s, showSellerFields: v })} />
      </Field>
      <Field label="Quote details">
        <CheckboxGroup options={META_FIELDS} value={s.metaFields} onChange={(v) => onChange({ ...s, metaFields: v })} />
      </Field>
    </div>
  );
}
