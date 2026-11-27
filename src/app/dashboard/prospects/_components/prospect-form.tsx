'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import type { Prospect } from '@/db/schema';
import { prospectInputSchema, SIZE_BANDS, sourceChoices } from '@/lib/prospects/rules';

import { createProspectAction, updateProspectAction } from '../actions';

type FormIn = z.input<typeof prospectInputSchema>;
type FormOut = z.output<typeof prospectInputSchema>;

type Props = {
  mode: 'create' | 'edit';
  prospect?: Prospect;
  /** Empty when offerings are turned off (or none are active): Product fit is hidden. */
  offerings: { id: string; name: string }[];
  /** The workspace's Source dropdown choices. */
  sources: string[];
  /** Disables every field and hides the submit button. */
  readOnly?: boolean;
  onSaved: (id: string) => void;
  onCancel?: () => void;
};

const inputCls =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 disabled:bg-slate-50 disabled:text-slate-500';
const labelCls = 'mb-1 block text-[12px] font-medium text-slate-600';

function defaultsFor(p?: Prospect): FormIn {
  return {
    companyName: p?.companyName ?? '',
    domain: p?.domain ?? '',
    contactName: p?.contactName ?? '',
    contactDesignation: p?.contactDesignation ?? '',
    contactEmail: p?.contactEmail ?? '',
    contactPhone: p?.contactPhone ?? '',
    industry: p?.industry ?? '',
    sizeBand: p?.sizeBand ?? '',
    city: p?.city ?? '',
    state: p?.state ?? '',
    productFitOfferingId: p?.productFitOfferingId ?? '',
    icpScore: p?.icpScore ?? '',
    sourceTag: p?.sourceTag ?? '',
    notes: p?.notes ?? '',
  } as FormIn;
}

type TextName =
  | 'companyName'
  | 'domain'
  | 'contactName'
  | 'contactDesignation'
  | 'contactEmail'
  | 'contactPhone'
  | 'industry'
  | 'city'
  | 'state';

export function ProspectForm({ mode, prospect, offerings, sources: sourceList, readOnly, onSaved, onCancel }: Props) {
  const listId = useId();
  const [pending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  // An older free-text source on this prospect stays selectable so editing never drops it.
  const sources = sourceChoices(sourceList, [prospect?.sourceTag]);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, dirtyFields },
  } = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(prospectInputSchema),
    defaultValues: defaultsFor(prospect),
  });

  const dis = readOnly || pending;

  function field(name: TextName, label: string, opts?: { type?: string; span2?: boolean }) {
    const err = errors[name]?.message as string | undefined;
    return (
      <div className={opts?.span2 ? 'sm:col-span-2' : undefined}>
        <label className={labelCls} htmlFor={`${listId}-${name}`}>
          {label}
        </label>
        <input
          id={`${listId}-${name}`}
          type={opts?.type ?? 'text'}
          disabled={dis}
          className={inputCls}
          aria-invalid={!!err}
          {...register(name)}
        />
        {err ? <p className="mt-1 text-[12px] text-red-600">{err}</p> : null}
      </div>
    );
  }

  const submit = handleSubmit(() => {
    setServerError(null);
    // Send raw form values (the action re-parses); in edit mode only the
    // keys the user changed, so untouched fields are never rewritten.
    const raw = getValues() as Record<string, unknown>;
    let payload: Record<string, unknown> = raw;
    if (mode === 'edit') {
      payload = Object.fromEntries(
        Object.keys(dirtyFields)
          .filter((k) => k in raw)
          .map((k) => [k, raw[k]]),
      );
      if (Object.keys(payload).length === 0) {
        onSaved(prospect!.id);
        return;
      }
    }
    startTransition(async () => {
      if (mode === 'create') {
        const r = await createProspectAction(payload);
        if (!r.ok) return setServerError(r.message);
        onSaved(r.data!.id);
      } else {
        const r = await updateProspectAction(prospect!.id, payload);
        if (!r.ok) return setServerError(r.message);
        onSaved(prospect!.id);
      }
    });
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {field('companyName', 'Company *', { span2: true })}
        {field('domain', 'Domain')}
        {field('industry', 'Industry')}
        {field('contactName', 'Contact name')}
        {field('contactDesignation', 'Designation')}
        {field('contactEmail', 'Email', { type: 'email' })}
        {field('contactPhone', 'Phone')}
        <div>
          <label className={labelCls} htmlFor={`${listId}-sizeBand`}>
            Size band
          </label>
          <select id={`${listId}-sizeBand`} disabled={dis} className={inputCls} {...register('sizeBand')}>
            <option value="">-</option>
            {SIZE_BANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        {offerings.length > 0 ? (
          <div>
            <label className={labelCls} htmlFor={`${listId}-fit`}>
              Product fit
            </label>
            <select id={`${listId}-fit`} disabled={dis} className={inputCls} {...register('productFitOfferingId')}>
              <option value="">-</option>
              {offerings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {field('city', 'City')}
        {field('state', 'State')}
        <div>
          <label className={labelCls} htmlFor={`${listId}-icp`}>
            ICP score (0-100)
          </label>
          <input
            id={`${listId}-icp`}
            type="number"
            min={0}
            max={100}
            step={1}
            disabled={dis}
            className={inputCls}
            {...register('icpScore', { setValueAs: (v) => (v === '' || v == null ? '' : Number(v)) })}
          />
          {errors.icpScore ? <p className="mt-1 text-[12px] text-red-600">{String(errors.icpScore.message)}</p> : null}
        </div>
        <div>
          <label className={labelCls} htmlFor={`${listId}-source`}>
            Source *
          </label>
          <select
            id={`${listId}-source`}
            disabled={dis}
            className={inputCls}
            aria-invalid={!!errors.sourceTag}
            {...register('sourceTag')}
          >
            <option value="">Select source</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {errors.sourceTag ? (
            <p className="mt-1 text-[12px] text-red-600">{String(errors.sourceTag.message)}</p>
          ) : null}
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor={`${listId}-notes`}>
            Notes
          </label>
          <textarea id={`${listId}-notes`} rows={4} disabled={dis} className={inputCls} {...register('notes')} />
        </div>
      </div>

      {serverError ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {serverError}
        </p>
      ) : null}

      {readOnly ? null : (
        <div className="flex justify-end gap-2">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {pending ? 'Saving...' : mode === 'create' ? 'Create prospect' : 'Save changes'}
          </button>
        </div>
      )}
    </form>
  );
}
