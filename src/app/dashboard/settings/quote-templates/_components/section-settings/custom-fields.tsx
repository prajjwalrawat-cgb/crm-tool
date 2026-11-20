'use client';

import { Trash2 } from 'lucide-react';

import { Button } from '../../../lead-capture/_components/ui';
import { Field, inputCls, selectCls, type SectionFormProps } from './controls';

export type DealFieldOption = { key: string; label: string };

export function CustomFieldsSettings({
  section,
  onChange,
  dealFields,
}: SectionFormProps<'custom_fields'> & { dealFields: DealFieldOption[] }) {
  const s = section.settings;
  const fields = s.fields;
  const used = new Set(fields.map((f) => f.key));
  const available = dealFields.filter((d) => !used.has(d.key));
  const known = new Set(dealFields.map((d) => d.key));

  const setFields = (next: typeof fields) => onChange({ ...s, fields: next });

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
        Prints the deal&apos;s custom field values as label / value rows.
      </p>
      {fields.length ? (
        <Field label="Fields" hint="The label printed on the quote; empty uses the field key.">
          <div className="space-y-1.5">
            {fields.map((f, i) => (
              <div key={f.key} className="flex items-center gap-2">
                <span className="w-36 shrink-0 truncate font-mono text-[11.5px] text-slate-500 dark:text-[#A1A1AA]" title={f.key}>
                  {f.key}
                  {known.has(f.key) ? null : ' (missing)'}
                </span>
                <input
                  aria-label={`Label for ${f.key}`}
                  className={inputCls}
                  value={f.label}
                  onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <Button variant="ghost" aria-label={`Remove ${f.key}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            ))}
          </div>
        </Field>
      ) : null}
      {available.length ? (
        <select
          aria-label="Add a deal field"
          className={selectCls}
          value=""
          onChange={(e) => {
            const d = dealFields.find((x) => x.key === e.target.value);
            if (d) setFields([...fields, { key: d.key, label: d.label }]);
          }}
        >
          <option value="">Add a deal field…</option>
          {available.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      ) : (
        <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          {dealFields.length ? 'All deal fields are added.' : 'No deal custom fields yet. Add them under Settings › Custom fields.'}
        </p>
      )}
    </div>
  );
}
