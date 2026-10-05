'use client';

import { fractionToPercent, percentToFraction } from '@/lib/incentives/format';
import { TERM_FIELDS, type StoredTerms, type TermField, type TermKey } from '@/lib/incentives/terms';
import { cn } from '@/lib/utils';

export const inputClass =
  'w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] tabular-nums focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]';

/**
 * Every plan term, driven by the TERM_FIELDS catalogue. Fraction terms are
 * edited as percentages ("25" → 0.25) — the stored value stays the fraction
 * the engine reads.
 */
export function TermsForm({
  value,
  onChange,
  disabled,
  only,
}: {
  value: StoredTerms;
  onChange: (next: StoredTerms) => void;
  disabled?: boolean;
  /** Restrict to these fields (bulk tool). */
  only?: readonly TermKey[];
}) {
  const fields = only ? TERM_FIELDS.filter((f) => only.includes(f.key)) : TERM_FIELDS;
  const set = (key: TermKey, v: unknown) => onChange({ ...value, [key]: v } as StoredTerms);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {fields.map((f) =>
        f.key === 'capAmountL' && !value.capEnabled && !only ? null : (
          <TermInput key={f.key} field={f} value={value[f.key]} disabled={disabled} onChange={(v) => set(f.key, v)} />
        ),
      )}
    </div>
  );
}

export function TermInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: TermField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">{field.label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        {field.kind === 'number' ? (
          <>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              disabled={disabled}
              value={field.unit === 'fraction' ? fractionToPercent(value as string) : ((value as string | null) ?? '')}
              onChange={(e) => onChange(field.unit === 'fraction' ? percentToFraction(e.target.value) : e.target.value)}
              className={inputClass}
            />
            <span className="w-10 shrink-0 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              {field.unit === 'fraction' ? '%' : field.unit}
            </span>
          </>
        ) : field.kind === 'enum' ? (
          <select disabled={disabled} value={String(value)} onChange={(e) => onChange(e.target.value)} className={inputClass}>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex items-center gap-2 py-1.5 text-[13px] text-slate-700 dark:text-[#D4D4D8]">
            <input type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
            {value ? 'On' : 'Off'}
          </span>
        )}
      </span>
      {field.hint ? <span className={cn('mt-0.5 block text-[11px] text-slate-400 dark:text-[#71717A]')}>{field.hint}</span> : null}
    </label>
  );
}
