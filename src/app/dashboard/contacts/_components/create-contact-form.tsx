'use client';

import { Loader2, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import { cn } from '@/lib/utils';

type Props = {
  onSubmit: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  resetKey: number;
  companyOptions: CompanyOption[];
};

export function CreateContactForm({
  onSubmit,
  pending,
  error,
  fieldErrors,
  resetKey,
  companyOptions,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.reset();
  }, [resetKey]);

  return (
    <form
      ref={formRef}
      action={onSubmit}
      className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      noValidate
    >
      <div>
        <h2 className="text-base font-semibold">Add contact</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          One name, email, or both — at least one is required.
        </p>
      </div>

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

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white shadow-sm transition',
          'hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-60',
          'dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:focus:ring-zinc-100',
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
      <label htmlFor={name} className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
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
          'placeholder:text-zinc-400 focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-zinc-200 focus:border-indigo-500 focus:ring-indigo-500/20',
          'dark:bg-zinc-950',
          hasError ? 'dark:border-red-800' : 'dark:border-zinc-800',
        )}
      />
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
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
        className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
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
            : 'border-zinc-200 focus:border-indigo-500 focus:ring-indigo-500/20',
          'dark:bg-zinc-950 dark:text-zinc-100',
          hasError ? 'dark:border-red-800' : 'dark:border-zinc-800',
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
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Tip: add a company first to link contacts to it.
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
          {errors!.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
