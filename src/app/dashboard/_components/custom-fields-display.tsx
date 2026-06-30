import {
  type CustomFieldDef,
  type CustomValues,
  formatCustomValue,
} from '@/lib/custom-fields/types';

/** Read-only render of custom field values (detail pages). Hides empties. */
export function CustomFieldsDisplay({
  defs,
  values,
  className,
}: {
  defs: CustomFieldDef[];
  values?: CustomValues | null;
  className?: string;
}) {
  const rows = defs
    .map((d) => ({ d, text: formatCustomValue(d, values?.[d.key]) }))
    .filter((r) => r.text !== '');
  if (rows.length === 0) return null;

  return (
    <dl className={className ?? 'grid grid-cols-2 gap-x-4 gap-y-2'}>
      {rows.map(({ d, text }) => (
        <div key={d.key} className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            {d.label}
          </dt>
          <dd className="truncate text-[13px] text-slate-800">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
