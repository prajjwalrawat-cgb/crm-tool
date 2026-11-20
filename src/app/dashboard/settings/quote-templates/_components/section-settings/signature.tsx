'use client';

import { Field, inputCls, ToggleRow, type SectionFormProps } from './controls';

export function SignatureSettings({ section, onChange }: SectionFormProps<'signature'>) {
  const s = section.settings;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Signatory name" htmlFor="sig-name" hint="Empty prints “Authorised signatory”.">
          <input id="sig-name" className={inputCls} value={s.signatoryName} onChange={(e) => onChange({ ...s, signatoryName: e.target.value })} />
        </Field>
        <Field label="Signatory title" htmlFor="sig-title">
          <input id="sig-title" className={inputCls} value={s.signatoryTitle} onChange={(e) => onChange({ ...s, signatoryTitle: e.target.value })} />
        </Field>
      </div>
      <ToggleRow
        label="Show a client acceptance block"
        checked={s.showClientAcceptance}
        onChange={(v) => onChange({ ...s, showClientAcceptance: v })}
      />
    </div>
  );
}
