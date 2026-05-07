'use client';

import { Loader2, Send } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { INVITE_ROLES } from '@/lib/team/schema';
import { cn } from '@/lib/utils';

type Props = {
  onSubmit: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  resetKey: number;
};

export function InviteForm({
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
      className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      noValidate
    >
      <div>
        <h2 className="text-base font-semibold">Invite teammate</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Sends an invitation email via Clerk. They&apos;ll join this org on
          accept.
        </p>
      </div>

      <Field
        name="email"
        type="email"
        label="Email"
        required
        placeholder="teammate@acme.com"
        autoFocus
        errors={fieldErrors.email}
      />

      <SelectField
        name="role"
        label="Role"
        defaultValue="member"
        errors={fieldErrors.role}
      >
        {INVITE_ROLES.map((r) => (
          <option key={r} value={r}>
            {r === 'admin' ? 'Admin — manage CRM + members' : 'Member — read/write CRM'}
          </option>
        ))}
      </SelectField>

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
            Sending…
          </>
        ) : (
          <>
            <Send className="h-4 w-4" aria-hidden />
            Send invitation
          </>
        )}
      </button>
    </form>
  );
}

type FieldProps = {
  name: string;
  label: string;
  type?: 'text' | 'email';
  required?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  errors?: string[];
};

function Field({
  name,
  label,
  type = 'text',
  required,
  placeholder,
  autoFocus,
  errors,
}: FieldProps) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? `${name}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
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

type SelectFieldProps = {
  name: string;
  label: string;
  defaultValue: string;
  errors?: string[];
  children: React.ReactNode;
};

function SelectField({
  name,
  label,
  defaultValue,
  errors,
  children,
}: SelectFieldProps) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? `${name}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
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
        {children}
      </select>
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
          {errors!.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
