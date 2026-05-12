'use client';

import { Loader2, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

type Props = {
  onSubmit: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  /** Increments after each successful submit so the form resets via remount. */
  resetKey: number;
};

export function CreateCompanyForm({
  onSubmit,
  pending,
  error,
  fieldErrors,
  resetKey,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.reset();
  }, [resetKey]);

  return (
    <form
      ref={formRef}
      action={onSubmit}
      className="flex flex-col gap-4"
      noValidate
    >
      <Field
        name="name"
        label="Name"
        required
        placeholder="Acme Corp"
        errors={fieldErrors.name}
        autoFocus
      />
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
