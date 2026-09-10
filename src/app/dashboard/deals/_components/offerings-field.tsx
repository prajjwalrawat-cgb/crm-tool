'use client';

import { ChevronDown, Star, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  defaultPrimary,
  groupByCategory,
  OFFERING_CATEGORY_CHIP,
  OFFERING_CATEGORY_PLURAL,
  OFFERING_PRIMARY_REQUIRED_MESSAGE,
  type OfferingOption,
} from '@/lib/offerings/types';
import { cn } from '@/lib/utils';

/**
 * The create form's Offerings control: a required, grouped multi-select with
 * a primary marker.
 *
 * Submits through two hidden inputs rather than a real `<select multiple>`:
 *   offeringIds       comma-joined uuids
 *   primaryOfferingId the one marked primary
 *
 * Hidden inputs because the surrounding form is uncontrolled — it dispatches
 * a plain `FormData` to a server action and is `.reset()` between deals — and
 * because the same two keys are then readable by `validateDealForm(fd)`
 * before the action fires, which is where the "at least one offering" block
 * has to happen (a failed round-trip resets the form and blanks the
 * Company/Contact selects; see the comment on that function).
 *
 * A native `<select multiple>` was the other option and is worse here: it
 * gives no room for the primary marker, ctrl-click multi-select is a known
 * usability trap, and it can't render a retired-vs-active distinction.
 */
export function OfferingsField({
  options,
  errors,
  required = true,
  defaultSelectedIds = [],
  defaultPrimaryId = null,
  extraOptions = [],
}: {
  /** Active offerings only — retired ones must not be taggable onto new deals. */
  options: OfferingOption[];
  errors?: string[];
  /**
   * Whether an empty selection is an error. True on create (always), and on
   * edit only when the deal ALREADY carries tags — an untagged legacy deal
   * must stay saveable. The caller derives it; see `offeringRuleFor`.
   */
  required?: boolean;
  defaultSelectedIds?: string[];
  defaultPrimaryId?: string | null;
  /**
   * Offerings already ON the deal that may be absent from `options` — i.e.
   * RETIRED ones. They are merged into the chip lookup but NOT into the
   * pickable list, which is exactly the promise the `active` flag makes:
   * still visible where it already is, not addable anywhere new.
   *
   * Without this the drawer would render a tagged-but-retired offering as
   * nothing at all, and — because the chips are what the hidden input is
   * built from — silently untag it on the next save.
   */
  extraOptions?: OfferingOption[];
}) {
  // Selection is local, uncontrolled state. The parent clears it after a
  // successful create by remounting this component with a new `key` — the
  // surrounding form is uncontrolled and calls `form.reset()`, which cannot
  // reach React state. A reset effect was the other option and is worse: it
  // fires a cascading render on every reset, and it has to lie about its
  // dependencies (the default arrays are new identities each render, so
  // listing them would clear the field on every keystroke elsewhere in the
  // form). A key change throws the state away in one step, with no effect.
  const [selected, setSelected] = useState<string[]>(defaultSelectedIds);
  const [primaryId, setPrimaryId] = useState<string | null>(defaultPrimaryId);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const byId = useMemo(
    () => new Map([...extraOptions, ...options].map((o) => [o.id, o])),
    [options, extraOptions],
  );

  /**
   * The primary actually submitted. Derived rather than stored so the two can
   * never disagree: unticking the offering that was marked primary must not
   * leave a stale primary id pointing at a row we are no longer inserting.
   * `defaultPrimary` also supplies the spec's auto-default — a lone selection
   * is primary without the user doing anything.
   */
  const effectivePrimary = defaultPrimary(selected, primaryId);
  const needsPrimaryChoice = selected.length > 1 && !effectivePrimary;

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const hasError = Boolean(errors?.length) || needsPrimaryChoice;
  const grouped = groupByCategory(options);

  return (
    <div className="flex flex-col gap-1.5" ref={boxRef}>
      <label
        htmlFor="offerings-trigger"
        className="text-xs font-medium text-slate-700"
      >
        Offerings
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>

      {/* The values the form actually submits. */}
      <input type="hidden" name="offeringIds" value={selected.join(',')} />
      <input
        type="hidden"
        name="primaryOfferingId"
        value={effectivePrimary ?? ''}
      />

      <button
        id="offerings-trigger"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        // No aria-invalid: it isn't supported on role=button (implicit here).
        // The error is announced through the described-by message instead,
        // and shown through the red border.
        aria-describedby={hasError ? 'offerings-error' : undefined}
        className={cn(
          'flex items-center justify-between rounded-md border bg-white px-3 py-1.5 text-left text-sm shadow-sm transition',
          'focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
        )}
      >
        <span className={selected.length === 0 ? 'text-slate-400' : ''}>
          {selected.length === 0
            ? 'What is this deal selling?'
            : `${selected.length} selected`}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      </button>

      {open ? (
        <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-[11.5px] text-slate-500">
              No active offerings. An admin can add them in Settings →
              Offerings.
            </p>
          ) : (
            grouped.map(({ category, items }) =>
              items.length === 0 ? null : (
                <div key={category} className="mb-1 last:mb-0">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {OFFERING_CATEGORY_PLURAL[category]}
                  </div>
                  {items.map((o) => (
                    <label
                      key={o.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] text-slate-700 hover:bg-indigo-50"
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(o.id)}
                        onChange={() => toggle(o.id)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="truncate">{o.name}</span>
                    </label>
                  ))}
                </div>
              ),
            )
          )}
        </div>
      ) : null}

      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const o = byId.get(id);
            if (!o) return null;
            const isPrimary = effectivePrimary === id;
            return (
              <li key={id}>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]',
                    OFFERING_CATEGORY_CHIP[o.category],
                  )}
                >
                  {/* With one tag the star is a static "this is the primary"
                      indicator, not a button — there is nothing to choose
                      between, and a clickable control that can't change
                      anything reads as broken. */}
                  <button
                    type="button"
                    onClick={() => setPrimaryId(id)}
                    disabled={selected.length === 1}
                    aria-label={
                      isPrimary ? `${o.name} is primary` : `Make ${o.name} primary`
                    }
                    aria-pressed={isPrimary}
                    className={cn(
                      'shrink-0',
                      selected.length > 1 && 'cursor-pointer',
                    )}
                  >
                    <Star
                      className={cn(
                        'h-3 w-3',
                        isPrimary
                          ? 'fill-amber-400 text-amber-400'
                          : 'text-slate-300 hover:text-amber-400',
                      )}
                      aria-hidden
                    />
                  </button>
                  <span
                    className={cn('truncate', !o.active && 'line-through')}
                    title={
                      o.active
                        ? undefined
                        : `${o.name} is retired — kept because this deal already carries it`
                    }
                  >
                    {o.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={`Remove ${o.name}`}
                    className="shrink-0 opacity-60 transition hover:opacity-100"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {hasError ? (
        <p id="offerings-error" className="text-xs text-red-600">
          {needsPrimaryChoice
            ? OFFERING_PRIMARY_REQUIRED_MESSAGE
            : errors!.join(' ')}
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          {selected.length > 1
            ? 'The starred offering labels the deal in the list; the funnel counts all of them.'
            : required && selected.length === 1
              ? 'To change what this sells, add the replacement before removing this one.'
              : 'Tag every product or service this deal includes.'}
        </p>
      )}
    </div>
  );
}
