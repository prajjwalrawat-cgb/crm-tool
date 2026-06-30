'use client';

import type { CustomFieldDef, CustomValues } from '@/lib/custom-fields/types';

/**
 * Renders inputs for admin-defined custom fields inside an existing
 * `<form action={...}>`. Inputs are uncontrolled and named `cf_<key>` so they
 * flow through FormData; the create/update actions parse that prefix. Pass
 * `values` to prefill (edit mode) and `errors` (keyed by `cf_<key>`).
 */
const inputCls =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

export function CustomFieldInputs({
  defs,
  values,
  errors,
}: {
  defs: CustomFieldDef[];
  values?: CustomValues;
  errors?: Record<string, string>;
}) {
  if (defs.length === 0) return null;
  return (
    <div className="flex flex-col gap-4 border-t border-slate-100 pt-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        Custom fields
      </p>
      {defs.map((d) => {
        const name = `cf_${d.key}`;
        const err = errors?.[name];
        const raw = values?.[d.key];

        if (d.fieldType === 'boolean') {
          return (
            <label key={d.key} className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name={name}
                defaultChecked={raw === true}
                className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              {d.label}
            </label>
          );
        }

        return (
          <div key={d.key} className="flex flex-col gap-1.5">
            <label htmlFor={name} className="text-xs font-medium text-slate-700">
              {d.label}
              {d.required ? <span className="ml-0.5 text-red-500">*</span> : null}
            </label>
            {d.fieldType === 'select' ? (
              <select id={name} name={name} defaultValue={raw != null ? String(raw) : ''} className={inputCls}>
                <option value="">— Select —</option>
                {d.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                id={name}
                name={name}
                type={d.fieldType === 'number' ? 'number' : d.fieldType === 'date' ? 'date' : 'text'}
                step={d.fieldType === 'number' ? 'any' : undefined}
                defaultValue={raw != null ? String(raw) : ''}
                className={inputCls}
              />
            )}
            {err ? <p className="text-xs text-red-600">{err}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
