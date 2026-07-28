'use client';

import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { patchDealAction } from '@/app/dashboard/deals/actions';
import { cn } from '@/lib/utils';

/**
 * A Deal Info card you can edit where it sits: the value turns into
 * control(s) on click, Enter/✓ saves, Esc/✕ reverts. One card owns one
 * concern and patches only its own fields, so an edit here can never
 * disturb a column it doesn't render (see lib/deals/header-patch.ts for
 * the regression that taught us to work this way).
 *
 * `fields` describes the inputs; `toPatch` turns their values into the
 * `patchDealAction` payload. Read-only cards just omit `fields`.
 */

export type CardField = {
  /** Doubles as the `patchDealAction` key — the two are kept 1:1 on purpose. */
  key: string;
  /** Shown above the input when a card has more than one. */
  label?: string;
  type: 'text' | 'number' | 'date' | 'select';
  value: string;
  options?: Array<{ value: string; label: string }>;
  step?: string;
  min?: string;
  placeholder?: string;
  widthClass?: string;
  /** What an empty input means for this field. Default: send '' through. */
  whenEmpty?: 'null' | 'zero';
};

export function EditableDetailCard({
  dealId,
  label,
  display,
  mono,
  fields,
  canEdit,
  hint,
}: {
  dealId: string;
  label: string;
  /** Read-only rendering of the current value. */
  display: string;
  mono?: boolean;
  fields?: CardField[];
  canEdit: boolean;
  hint?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((fields ?? []).map((f) => [f.key, f.value])),
  );
  const firstInputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  // Re-seed from the server whenever a fresh render lands and we're idle.
  const serverKey = (fields ?? []).map((f) => `${f.key}=${f.value}`).join('|');
  const [syncedKey, setSyncedKey] = useState(serverKey);
  if (syncedKey !== serverKey && !editing) {
    setSyncedKey(serverKey);
    setValues(Object.fromEntries((fields ?? []).map((f) => [f.key, f.value])));
  }

  useEffect(() => {
    if (editing) firstInputRef.current?.focus();
  }, [editing]);

  const editable = canEdit && fields != null && fields.length > 0;

  function cancel() {
    setValues(Object.fromEntries((fields ?? []).map((f) => [f.key, f.value])));
    setEditing(false);
  }

  function save() {
    if (!fields) return;
    const unchanged = fields.every((f) => values[f.key] === f.value);
    if (unchanged) {
      setEditing(false);
      return;
    }
    // Field keys ARE the patch keys, so the payload is built here rather than
    // via a mapper prop — a function can't cross the server/client boundary.
    const payload: Record<string, unknown> = { id: dealId };
    for (const f of fields) {
      const raw = values[f.key] ?? '';
      payload[f.key] =
        raw === '' && f.whenEmpty === 'null'
          ? null
          : raw === '' && f.whenEmpty === 'zero'
            ? '0'
            : raw;
    }
    setEditing(false);
    startTransition(async () => {
      const result = await patchDealAction(payload);
      if (!result.ok) {
        toast.error(result.message);
        cancel();
        router.refresh();
        return;
      }
      // The card's value comes from the server render, so pull it fresh
      // rather than mirroring the write locally.
      router.refresh();
    });
  }

  return (
    <div
      className={cn(
        'group relative rounded-lg border border-slate-200 bg-white p-3 transition',
        editable && !editing && 'hover:border-slate-300',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {label}
        </span>
        {editable ? (
          editing ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={save}
                aria-label={`Save ${label}`}
                className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={cancel}
                aria-label={`Cancel editing ${label}`}
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${label}`}
              className="rounded p-0.5 text-slate-300 opacity-0 transition hover:bg-slate-100 hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          )
        ) : null}
      </div>

      {editing && fields ? (
        <div
          className="mt-1.5 flex flex-wrap items-end gap-2"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        >
          {fields.map((f, i) => (
            <label key={f.key} className="flex flex-col gap-0.5">
              {f.label ? (
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {f.label}
                </span>
              ) : null}
              {f.type === 'select' ? (
                <select
                  ref={
                    i === 0
                      ? (firstInputRef as React.RefObject<HTMLSelectElement>)
                      : undefined
                  }
                  value={values[f.key] ?? ''}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                  className={cn(
                    'rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px]',
                    f.widthClass ?? 'w-full',
                  )}
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  ref={
                    i === 0
                      ? (firstInputRef as React.RefObject<HTMLInputElement>)
                      : undefined
                  }
                  type={f.type}
                  step={f.step}
                  min={f.min}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ''}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                  className={cn(
                    'rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px]',
                    f.type === 'number' && 'text-right font-mono',
                    f.widthClass ?? 'w-full',
                  )}
                />
              )}
            </label>
          ))}
        </div>
      ) : (
        <div
          className={cn(
            'mt-1 text-[15px] font-medium text-slate-900',
            mono && 'font-mono',
            pending && 'opacity-50',
          )}
        >
          {display}
        </div>
      )}

      {hint ? (
        <p className="mt-1 text-[11px] leading-tight text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}
