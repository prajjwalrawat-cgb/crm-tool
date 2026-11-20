'use client';

import type { ReactNode } from 'react';

import type { QuoteSection } from '@/lib/quotes/template-schema';

import { Field, inputCls, Toggle } from '../../../lead-capture/_components/ui';

export { Field, inputCls };
export { selectCls } from '../../../lead-capture/_components/ui';

type SectionOf<T extends QuoteSection['type']> = Extract<QuoteSection, { type: T }>;

/** Props for one section type's settings form. */
export type SectionFormProps<T extends QuoteSection['type']> = {
  section: SectionOf<T>;
  onChange: (settings: SectionOf<T>['settings']) => void;
};

export function ToggleRow({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="pt-0.5">
        <Toggle checked={checked} onChange={onChange} label={label} />
      </div>
      <div>
        <div className="text-[12.5px] text-slate-700 dark:text-[#D4D4D8]">{label}</div>
        {hint ? <div className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">{hint}</div> : null}
      </div>
    </div>
  );
}

/** Number input that stores NaN for an empty box (the schema then flags it). */
export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
}: {
  id?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      id={id}
      type="number"
      className={inputCls}
      min={min}
      max={max}
      step={step}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.valueAsNumber)}
    />
  );
}

/** Checkbox list over a fixed option order; the result keeps that order. */
export function CheckboxGroup<K extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { key: K; label: string }[];
  value: readonly K[];
  onChange: (v: K[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {options.map((o) => (
        <label key={o.key} className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-[#D4D4D8]">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-indigo-600"
            checked={value.includes(o.key)}
            onChange={(e) => {
              const set = new Set(value);
              if (e.target.checked) set.add(o.key);
              else set.delete(o.key);
              onChange(options.map((x) => x.key).filter((k) => set.has(k)));
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
