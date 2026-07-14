'use client';

import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { updateDealFieldAction } from '../actions';

type Field = 'nextStep' | 'competitor' | 'source';

/**
 * Inline-editable freeform deal field (Next Step / Competitor / Source).
 * Reads like the sidebar DetailCards; clicking the pencil turns it into an
 * input (text, textarea, or select) and commits through updateDealFieldAction.
 */
export function DealFieldEditor({
  dealId,
  field,
  label,
  initialValue,
  canEdit,
  placeholder,
  multiline,
  options,
}: {
  dealId: string;
  field: Field;
  label: string;
  initialValue: string | null;
  canEdit: boolean;
  placeholder?: string;
  multiline?: boolean;
  /** When provided, the field edits as a <select>. */
  options?: string[];
}) {
  const [value, setValue] = useState<string | null>(initialValue);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialValue ?? '');
  const [pending, startTransition] = useTransition();

  function save(next: string) {
    const trimmed = next.trim();
    const normalized = trimmed === '' ? null : trimmed;
    if (normalized === value) {
      setEditing(false);
      return;
    }
    const previous = value;
    setValue(normalized);
    setEditing(false);
    startTransition(async () => {
      const result = await updateDealFieldAction({
        dealId,
        field,
        value: normalized,
      });
      if (!result.ok) {
        setValue(previous);
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">
          {label}
        </div>
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => {
              setDraft(value ?? '');
              setEditing(true);
            }}
            aria-label={`Edit ${label}`}
            className="text-slate-300 hover:text-indigo-500"
          >
            <Pencil className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-slate-400" aria-hidden />
        ) : null}
      </div>

      {editing ? (
        <div className="mt-1">
          {options ? (
            <select
              autoFocus
              value={draft}
              onChange={(e) => save(e.target.value)}
              className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[13px] text-slate-800 focus:border-indigo-400 focus:outline-none"
            >
              <option value="">—</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : multiline ? (
            <div>
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                placeholder={placeholder}
                className="w-full resize-none rounded border border-slate-200 px-1.5 py-1 text-[13px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
              />
              <EditButtons onSave={() => save(draft)} onCancel={() => setEditing(false)} />
            </div>
          ) : (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save(draft);
                } else if (e.key === 'Escape') {
                  setEditing(false);
                }
              }}
              onBlur={() => save(draft)}
              placeholder={placeholder}
              className="w-full rounded border border-slate-200 px-1.5 py-1 text-[13px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
            />
          )}
        </div>
      ) : (
        <div
          className={cn(
            'mt-1 whitespace-pre-wrap text-sm',
            value ? 'text-slate-800' : 'text-slate-400',
          )}
        >
          {value ?? (canEdit ? placeholder ?? 'Add…' : '—')}
        </div>
      )}
    </div>
  );
}

function EditButtons({
  onSave,
  onCancel,
}: {
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-1 flex justify-end gap-1">
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        className="rounded p-1 text-slate-400 hover:bg-slate-100"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onSave}
        aria-label="Save"
        className="rounded bg-indigo-600 p-1 text-white hover:bg-indigo-500"
      >
        <Check className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
