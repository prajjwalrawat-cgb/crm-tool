'use client';

import { Loader2, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactOption } from '@/lib/contacts/queries';
import { KNOWN_CURRENCIES } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS, DEAL_STAGES } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

type Props = {
  onSubmit: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  resetKey: number;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
};

export function CreateDealForm({
  onSubmit,
  pending,
  error,
  fieldErrors,
  resetKey,
  companyOptions,
  contactOptions,
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
      <p className="text-xs text-slate-500">
        Track an opportunity through your pipeline.
      </p>

      <Field
        name="name"
        label="Name"
        required
        placeholder="Acme — annual contract"
        autoFocus
        errors={fieldErrors.name}
      />

      <SelectField name="stage" label="Stage" errors={fieldErrors.stage} defaultValue="lead">
        {DEAL_STAGES.map((stage) => (
          <option key={stage} value={stage}>
            {DEAL_STAGE_LABELS[stage]}
          </option>
        ))}
      </SelectField>

      <div className="grid grid-cols-[1fr_88px] gap-3">
        <Field
          name="amount"
          label="Amount"
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          defaultValue="0"
          errors={fieldErrors.amount}
        />
        <SelectField
          name="currency"
          label="Currency"
          errors={fieldErrors.currency}
          defaultValue="USD"
        >
          {KNOWN_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
      </div>

      <Field
        name="expectedCloseDate"
        label="Expected close date"
        type="date"
        errors={fieldErrors.expectedCloseDate}
      />

      <SelectField
        name="companyId"
        label="Company"
        errors={fieldErrors.companyId}
        defaultValue=""
        emptyHint={companyOptions.length === 0 ? 'Add a company first to link deals to it.' : undefined}
      >
        <option value="">— No company —</option>
        {companyOptions.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>

      <SelectField
        name="contactId"
        label="Contact"
        errors={fieldErrors.contactId}
        defaultValue=""
        emptyHint={contactOptions.length === 0 ? 'Add a contact first to link deals to it.' : undefined}
      >
        <option value="">— No contact —</option>
        {contactOptions.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </SelectField>

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
            Create deal
          </>
        )}
      </button>
    </form>
  );
}

type FieldProps = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date';
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  defaultValue?: string;
  step?: string;
  min?: string;
  errors?: string[];
};

function Field({
  name,
  label,
  type = 'text',
  placeholder,
  required,
  autoFocus,
  defaultValue,
  step,
  min,
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
        type={type}
        placeholder={placeholder}
        autoFocus={autoFocus}
        defaultValue={defaultValue}
        step={step}
        min={min}
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

type SelectFieldProps = {
  name: string;
  label: string;
  defaultValue: string;
  errors?: string[];
  emptyHint?: string;
  children: React.ReactNode;
};

function SelectField({
  name,
  label,
  defaultValue,
  errors,
  emptyHint,
  children,
}: SelectFieldProps) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? `${name}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-slate-700">
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
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
          '',
          hasError ? '' : '',
        )}
      >
        {children}
      </select>
      {emptyHint ? (
        <p className="text-xs text-slate-500">{emptyHint}</p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600">
          {errors!.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
