'use client';

import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { patchCompanyAction } from '@/app/dashboard/companies/actions';
import { cn } from '@/lib/utils';

/**
 * A company field you can edit where it sits. Click the pencil, the
 * value becomes an input, Enter/✓ saves and Esc/✕ reverts — the same
 * interaction and the same chrome as `EditableDetailCard` on the deal
 * detail page.
 *
 * Not a reuse of that component: it is hardwired to `patchDealAction`
 * and a server action cannot be handed across the client boundary as a
 * prop, so the deal card's own comment ("field keys ARE the patch keys,
 * so the payload is built here rather than via a mapper prop") applies
 * here too. This is the company-shaped sibling, one card per field.
 *
 * `patchCompanyAction` re-checks `manageCompanies` server-side; `canEdit`
 * only decides whether the affordance is offered.
 */

export type CompanyCardField = {
  /** Doubles as the `patchCompanyAction` key — kept 1:1 on purpose. */
  key: 'name' | 'domain' | 'industry';
  label?: string;
  value: string;
  placeholder?: string;
  /** Empty input means NULL rather than an empty string. */
  nullWhenEmpty?: boolean;
};

export function EditableCompanyCard({
  companyId,
  label,
  display,
  mono,
  field,
  canEdit,
  hint,
}: {
  companyId: string;
  label: string;
  /** Read-only rendering of the current value. */
  display: string;
  mono?: boolean;
  /** Omit to render a read-only card. */
  field?: CompanyCardField;
  canEdit: boolean;
  hint?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(field?.value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed from the server whenever a fresh render lands and we're idle,
  // so a change made elsewhere (or a realtime update) is not masked by
  // stale local state.
  const serverValue = field?.value ?? '';
  const [syncedValue, setSyncedValue] = useState(serverValue);
  if (syncedValue !== serverValue && !editing) {
    setSyncedValue(serverValue);
    setValue(serverValue);
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const editable = canEdit && field != null;

  function cancel() {
    setValue(field?.value ?? '');
    setEditing(false);
  }

  function save() {
    if (!field) return;
    const next = value.trim();
    if (next === field.value) {
      setEditing(false);
      return;
    }
    if (next === '' && !field.nullWhenEmpty) {
      toast.error(`${label} is required.`);
      return;
    }
    setEditing(false);
    startTransition(async () => {
      const result = await patchCompanyAction({
        id: companyId,
        [field.key]: next === '' ? null : next,
      });
      if (!result.ok) {
        toast.error(result.message);
        cancel();
        router.refresh();
        return;
      }
      // The displayed value comes from the server render, so pull it
      // fresh rather than mirroring the write locally.
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
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
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

      {editing && field ? (
        <input
          ref={inputRef}
          type="text"
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
          className={cn(
            'mt-1.5 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px]',
            mono && 'font-mono',
          )}
        />
      ) : (
        <div
          className={cn(
            'mt-1 text-sm text-slate-900',
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
