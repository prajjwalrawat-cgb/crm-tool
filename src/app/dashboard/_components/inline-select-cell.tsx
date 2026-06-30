'use client';

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Click-to-edit dropdown table cell. Shows the current label; click turns it
 * into a `<select>`. Commits on change (if different), cancels on blur/Esc.
 * Used for linked fields (deal company/contact) in the list.
 */
export function InlineSelectCell({
  value,
  options,
  render,
  placeholder = '—',
  emptyLabel = '— None —',
  onCommit,
  ariaLabel,
  disabled,
}: {
  value: string;
  options: { value: string; label: string }[];
  /** Read-view override (e.g. show a stored name even if not in options). */
  render?: React.ReactNode;
  placeholder?: string;
  emptyLabel?: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const read =
    render ?? options.find((o) => o.value === value)?.label ?? placeholder;

  if (disabled) {
    return <span className="block truncate text-slate-400">{read}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${ariaLabel}`}
        title={`Edit ${ariaLabel}`}
        className={cn(
          'block w-full truncate rounded px-1 py-0.5 text-left transition hover:bg-slate-100 hover:ring-1 hover:ring-slate-200',
          !value && 'text-slate-400',
        )}
      >
        {read}
      </button>
    );
  }

  return (
    <select
      ref={ref}
      value={value}
      onChange={(e) => {
        setEditing(false);
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setEditing(false);
      }}
      aria-label={ariaLabel}
      className="w-full rounded border border-indigo-300 bg-white px-1 py-0.5 text-[13px] shadow-sm outline-none focus:ring-2 focus:ring-indigo-500/30"
    >
      <option value="">{emptyLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
