'use client';

import { AlertTriangle, Loader2, Plus, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import type { CustomFieldDef } from '@/lib/custom-fields/types';
import type { DedupMatch } from '@/lib/dedup/queries';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { CustomFieldInputs } from '../../_components/custom-field-inputs';
import { OwnerFormField } from '../../_components/owner-form-field';
import { checkDuplicateContactAction } from '../actions';

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
  resetKey: number;
  companyOptions: CompanyOption[];
  teammates: Teammate[];
  currentUserId: string;
  customFieldDefs: CustomFieldDef[];
};

export function CreateContactForm({
  onSubmit,
  pending,
  error,
  fieldErrors,
  resetKey,
  companyOptions,
  teammates,
  currentUserId,
  customFieldDefs,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dup, setDup] = useState<{
    emailMatch: { id: string; name: string } | null;
    nameMatches: DedupMatch[];
  }>({ emailMatch: null, nameMatches: [] });

  const [prevReset, setPrevReset] = useState(resetKey);
  if (prevReset !== resetKey) {
    setPrevReset(resetKey);
    setDup({ emailMatch: null, nameMatches: [] });
  }
  useEffect(() => {
    formRef.current?.reset();
  }, [resetKey]);

  // Debounced live duplicate check (Module 5): email exact (block) + name fuzzy.
  function onFormInput() {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    const email = String(fd.get('email') ?? '').trim();
    const firstName = String(fd.get('firstName') ?? '').trim();
    const lastName = String(fd.get('lastName') ?? '').trim();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      checkDuplicateContactAction({ email, firstName, lastName })
        .then(setDup)
        .catch(() => setDup({ emailMatch: null, nameMatches: [] }));
    }, 400);
  }

  return (
    <form
      ref={formRef}
      action={onSubmit}
      onInput={onFormInput}
      className="flex flex-col gap-4"
      noValidate
    >
      <p className="text-xs text-slate-500">
        One name, email, or both — at least one is required.
      </p>

      {dup.emailMatch ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-[12px] dark:border-red-500/30 dark:bg-red-500/10">
          <div className="flex items-center gap-1.5 font-semibold text-red-700 dark:text-red-300">
            <XCircle className="h-3.5 w-3.5" /> This email already exists
          </div>
          <div className="mt-0.5 text-red-800 dark:text-red-200">
            A contact with this email is already in your workspace:{' '}
            <Link
              href={`/dashboard/contacts/${dup.emailMatch.id}`}
              className="font-medium underline"
            >
              {dup.emailMatch.name}
            </Link>
            . Contact emails must be unique — saving will be rejected.
          </div>
        </div>
      ) : dup.nameMatches.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[12px] dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" /> Possible duplicate
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {dup.nameMatches.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-amber-900 dark:text-amber-100">
                  {m.label}
                  {m.sublabel ? <span className="ml-1 text-amber-600">· {m.sublabel}</span> : null}
                </span>
                <Link
                  href={`/dashboard/contacts/${m.id}`}
                  className="shrink-0 font-medium text-amber-800 underline dark:text-amber-200"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field
          name="firstName"
          label="First name"
          placeholder="Jane"
          autoFocus
          errors={fieldErrors.firstName}
        />
        <Field
          name="lastName"
          label="Last name"
          placeholder="Doe"
          errors={fieldErrors.lastName}
        />
      </div>

      <Field
        name="email"
        type="email"
        label="Email"
        placeholder="jane@acme.com"
        errors={fieldErrors.email}
      />
      <Field
        name="phone"
        type="tel"
        label="Phone"
        placeholder="+1 555 0100"
        errors={fieldErrors.phone}
      />
      <Field
        name="title"
        label="Title"
        placeholder="VP of Sales"
        errors={fieldErrors.title}
      />

      <CompanyPicker
        options={companyOptions}
        errors={fieldErrors.companyId}
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
            Create contact
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
  type?: 'text' | 'email' | 'tel';
  autoFocus?: boolean;
  errors?: string[];
};

function Field({
  name,
  label,
  placeholder,
  type = 'text',
  autoFocus,
  errors,
}: FieldProps) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? `${name}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-slate-700">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
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

function CompanyPicker({
  options,
  errors,
}: {
  options: CompanyOption[];
  errors?: string[];
}) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? 'companyId-error' : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor="companyId"
        className="text-xs font-medium text-slate-700"
      >
        Company
      </label>
      <select
        id="companyId"
        name="companyId"
        defaultValue=""
        aria-invalid={hasError || undefined}
        aria-describedby={errorId}
        className={cn(
          'rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition',
          'focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
          '',
          hasError ? '' : '',
        )}
      >
        <option value="">— No company —</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      {options.length === 0 ? (
        <p className="text-xs text-slate-500">
          Tip: add a company first to link contacts to it.
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600">
          {errors!.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
