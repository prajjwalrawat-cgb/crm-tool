'use client';

import { AlertTriangle, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { CustomFieldDef } from '@/lib/custom-fields/types';
import type { DedupMatch } from '@/lib/dedup/queries';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { CustomFieldInputs } from '../../_components/custom-field-inputs';
import { OwnerFormField } from '../../_components/owner-form-field';
import { findSimilarCompaniesAction } from '../actions';

function customErrors(fieldErrors: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([k]) => k.startsWith('cf_'))
      .map(([k, v]) => [k, v[0] ?? '']),
  );
}

type Props = {
  onSubmit: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  /** Increments after each successful submit so the form resets via remount. */
  resetKey: number;
  teammates: Teammate[];
  currentUserId: string;
  customFieldDefs: CustomFieldDef[];
};

export function CreateCompanyForm({
  onSubmit,
  pending,
  error,
  fieldErrors,
  resetKey,
  teammates,
  currentUserId,
  customFieldDefs,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [matches, setMatches] = useState<DedupMatch[]>([]);

  // Reset controlled state on a new resetKey (render-time prop sync, not an
  // effect) + clear the uncontrolled form DOM in the effect.
  const [prevReset, setPrevReset] = useState(resetKey);
  if (prevReset !== resetKey) {
    setPrevReset(resetKey);
    setName('');
    setMatches([]);
  }
  useEffect(() => {
    formRef.current?.reset();
  }, [resetKey]);

  // Debounced "similar existing company" lookup (Module 5). Empty when DEDUP off.
  useEffect(() => {
    const q = name.trim();
    const handle = setTimeout(() => {
      if (q.length < 2) {
        setMatches([]);
        return;
      }
      findSimilarCompaniesAction(q).then(setMatches).catch(() => setMatches([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [name]);

  return (
    <form
      ref={formRef}
      action={onSubmit}
      className="flex flex-col gap-4"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="name" className="text-xs font-medium text-slate-700">
          Company Name<span className="ml-0.5 text-red-500">*</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          placeholder="Acme Corp"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={Boolean(fieldErrors.name?.length) || undefined}
          className={cn(
            'rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition',
            'placeholder:text-slate-400 focus:outline-none focus:ring-2',
            fieldErrors.name?.length
              ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
              : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
          )}
        />
        {fieldErrors.name?.length ? (
          <p className="text-xs text-red-600">{fieldErrors.name.join(' ')}</p>
        ) : null}
        {matches.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5" />
              {matches.length === 1 ? 'Similar existing company' : 'Similar existing companies'}
            </div>
            <ul className="space-y-1">
              {matches.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="min-w-0 truncate text-amber-900 dark:text-amber-100">
                    {m.label}
                    {m.sublabel ? (
                      <span className="ml-1 text-amber-600 dark:text-amber-300">· {m.sublabel}</span>
                    ) : null}
                  </span>
                  <Link
                    href={`/dashboard/companies/${m.id}`}
                    className="shrink-0 font-medium text-amber-800 underline hover:text-amber-900 dark:text-amber-200"
                  >
                    Use this instead
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[10.5px] text-amber-600 dark:text-amber-300">
              Or continue below to create a new company anyway.
            </p>
          </div>
        ) : null}
      </div>
      {/* Records dedup_override when the user creates despite a warning. */}
      <input type="hidden" name="dedupOverride" value={matches.length > 0 ? '1' : '0'} />
      <Field
        name="domain"
        label="Domain"
        placeholder="acme.com"
        errors={fieldErrors.domain}
      />
      <Field
        name="industry"
        label="Industry"
        placeholder="SaaS"
        errors={fieldErrors.industry}
      />

      <OwnerFormField
        teammates={teammates}
        currentUserId={currentUserId}
        errors={fieldErrors.ownerId}
      />

      <CustomFieldInputs defs={customFieldDefs} errors={customErrors(fieldErrors)} />

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition',
          'hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-60',
          '',
        )}
      >
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Saving…
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" aria-hidden />
            Create company
          </>
        )}
      </button>
    </form>
  );
}

type FieldProps = {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  errors?: string[];
};

function Field({
  name,
  label,
  placeholder,
  required,
  autoFocus,
  errors,
}: FieldProps) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? `${name}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-slate-700">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      <input
        id={name}
        name={name}
        type="text"
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={hasError || undefined}
        aria-describedby={errorId}
        className={cn(
          'rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition',
          'placeholder:text-slate-400 focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
          '',
          hasError ? '' : '',
        )}
      />
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600">
          {errors!.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
