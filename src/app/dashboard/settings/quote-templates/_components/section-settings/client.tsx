'use client';

import { Field, inputCls, ToggleRow, type SectionFormProps } from './controls';

export function ClientSettings({ section, onChange }: SectionFormProps<'client'>) {
  const s = section.settings;
  return (
    <div className="space-y-3">
      <Field label="Bill-to label" htmlFor="cl-bill">
        <input id="cl-bill" className={inputCls} value={s.billToLabel} onChange={(e) => onChange({ ...s, billToLabel: e.target.value })} />
      </Field>
      <ToggleRow
        label="Show the ship-to address"
        hint="Printed when the quote has a separate consignee."
        checked={s.showShipTo}
        onChange={(v) => onChange({ ...s, showShipTo: v })}
      />
      {s.showShipTo ? (
        <Field label="Ship-to label" htmlFor="cl-ship">
          <input id="cl-ship" className={inputCls} value={s.shipToLabel} onChange={(e) => onChange({ ...s, shipToLabel: e.target.value })} />
        </Field>
      ) : null}
    </div>
  );
}
