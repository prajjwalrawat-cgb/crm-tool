'use client';

import { Loader2, Save, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactOption } from '@/lib/contacts/queries';
import { fromMinorUnits, KNOWN_CURRENCIES } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS, DEAL_STAGES } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

import { Drawer } from '../../_components/drawer';

type Props = {
  open: boolean;
  onClose: () => void;
  deal: DealRow | null;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  onSubmit: (formData: FormData) => void;
  onDelete: () => void;
  pending: boolean;
  deletePending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  canDelete: boolean;
};

export function EditDealDrawer({
  open,
  onClose,
  deal,
  companyOptions,
  contactOptions,
  onSubmit,
  onDelete,
  pending,
  deletePending,
  error,
  fieldErrors,
  canDelete,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.reset();
  }, [deal?.id]);

  const initialAmount = deal
    ? fromMinorUnits(deal.amountMinor, deal.currency).toString()
    : '0';
  // Drizzle returns the date column as 'YYYY-MM-DD' string or null. Pass it
  // through to the date input as-is — no Date parsing needed.
  const initialDate = deal?.expectedCloseDate ?? '';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Edit deal"
      description={deal?.name}
      footer={
        <div className="flex items-center justify-between gap-3">
          {canDelete ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={deletePending || pending}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
            >
              {deletePending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              )}
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="edit-deal-form"
              disabled={pending}
              className={cn(
                'inline-flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition',
                'hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60',
                'dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
              )}
            >
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" aria-hidden />
                  Save changes
                </>
              )}
            </button>
          </div>
        </div>
      }
    >
      <form
        id="edit-deal-form"
        ref={formRef}
        action={onSubmit}
        className="flex flex-col gap-4"
        noValidate
      >
        <input type="hidden" name="id" value={deal?.id ?? ''} />

        <Field
          name="name"
          label="Name"
          required
          defaultValue={deal?.name ?? ''}
          errors={fieldErrors.name}
        />

        <Select
          name="stage"
          label="Stage"
          defaultValue={deal?.stage ?? 'lead'}
          errors={fieldErrors.stage}
        >
          {DEAL_STAGES.map((s) => (
            <option key={s} value={s}>
              {DEAL_STAGE_LABELS[s]}
            </option>
          ))}
        </Select>

        <div className="grid grid-cols-[1fr_88px] gap-3">
          <Field
            name="amount"
            label="Amount"
            type="number"
            step="0.01"
            min="0"
            defaultValue={initialAmount}
            errors={fieldErrors.amount}
          />
          <Select
            name="currency"
            label="Currency"
            defaultValue={deal?.currency ?? 'USD'}
            errors={fieldErrors.currency}
          >
            {KNOWN_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>

        <Field
          name="expectedCloseDate"
          label="Expected close date"
          type="date"
          defaultValue={initialDate}
          errors={fieldErrors.expectedCloseDate}
        />

        <Select
          name="companyId"
          label="Company"
          defaultValue={deal?.companyId ?? ''}
          errors={fieldErrors.companyId}
        >
          <option value="">— No company —</option>
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        <Select
          name="contactId"
          label="Contact"
          defaultValue={deal?.contactId ?? ''}
          errors={fieldErrors.contactId}
        >
          <option value="">— No contact —</option>
          {contactOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>

        {error ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
      </form>
    </Drawer>
  );
}

type FieldProps = {
  name: string;
  label: string;
  defaultValue: string;
  type?: 'text' | 'number' | 'date';
  required?: boolean;
  step?: string;
  min?: string;
  errors?: string[];
};

function Field({
  name,
  label,
  defaultValue,
  type = 'text',
  required,
  step,
  min,
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
        defaultValue={defaultValue}
        step={step}
        min={min}
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

type SelectProps = {
  name: string;
  label: string;
  defaultValue: string;
  errors?: string[];
  children: React.ReactNode;
};

function Select({ name, label, defaultValue, errors, children }: SelectProps) {
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
