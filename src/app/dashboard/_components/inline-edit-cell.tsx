'use client';

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Click-to-edit table cell. Shows a formatted value; click (or focus + Enter)
 * turns it into an input. Enter / blur commits (only if changed), Esc cancels.
 * Stays uncontrolled-ish: `value` is the source of truth and the local draft
 * re-syncs whenever `value` changes while not editing (e.g. server refresh).
 */
export function InlineEditCell({
  value,
  type = 'text',
  placeholder = '—',
  align = 'left',
  render,
  onCommit,
  ariaLabel,
  disabled,
  step,
  min,
}: {
  value: string;
  type?: 'text' | 'number' | 'date';
  placeholder?: string;
  align?: 'left' | 'right';
  /** Formatter for the read view (editing always shows the raw `value`). */
  render?: (v: string) => React.ReactNode;
  onCommit: (next: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  step?: string;
  min?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select?.();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const read = render ? render(value) : value || placeholder;

  if (disabled) {
    return (
      <span className={cn('block truncate', align === 'right' && 'text-right')}>
        {read}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        aria-label={`Edit ${ariaLabel}`}
        title={`Edit ${ariaLabel}`}
        className={cn(
          'block w-full truncate rounded px-1 py-0.5 text-left transition hover:bg-slate-100 hover:ring-1 hover:ring-slate-200',
          align === 'right' && 'text-right',
          !value && 'text-slate-400',
        )}
      >
        {read}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  return (
    <input
      ref={inputRef}
      type={type}
      value={draft}
      step={step}
      min={min}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
        // Tab falls through → blur fires → commit, then focus advances.
      }}
      aria-label={ariaLabel}
      className={cn(
        'w-full rounded border border-indigo-300 bg-white px-1 py-0.5 text-[13px] shadow-sm outline-none focus:ring-2 focus:ring-indigo-500/30',
        align === 'right' && 'text-right',
      )}
    />
  );
}
