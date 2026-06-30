'use client';

import { Loader2, Save, Trash2 } from 'lucide-react';

import type { MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactOption } from '@/lib/contacts/queries';
import type { CustomFieldDef, CustomValues } from '@/lib/custom-fields/types';
import { fromMinorUnits, KNOWN_CURRENCIES } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS, DEAL_STAGES } from '@/lib/deals/schema';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { CustomFieldInputs } from '../../_components/custom-field-inputs';
import { Drawer } from '../../_components/drawer';
import { OwnerFormField } from '../../_components/owner-form-field';

function customErrors(fieldErrors: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([k]) => k.startsWith('cf_'))
      .map(([k, v]) => [k, v[0] ?? '']),
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  deal: DealRow | null;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  teammates: Teammate[];
  currentUserId: string;
  currentRole: MembershipRole;
  customFieldDefs: CustomFieldDef[];
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
  teammates,
  currentUserId,
  currentRole,
  customFieldDefs,
  onSubmit,
  onDelete,
  pending,
  deletePending,
  error,
  fieldErrors,
  canDelete,
}: Props) {
  // Only owner + manager can reassign a deal; a manager may not assign to an
  // owner, so they get the team minus owners. Anyone else doesn't see the
  // field and the edit leaves the owner unchanged.
  const canAssign = currentRole === 'owner' || currentRole === 'manager';
  const assignable =
    currentRole === 'owner'
      ? teammates
      : teammates.filter((t) => t.role !== 'owner');
  // Inputs use `defaultValue` (uncontrolled). React doesn't update the DOM
  // `defaultValue` after first mount — so when this drawer first renders
  // with `deal=null` and later gets `deal=<row>`, the inputs keep their
  // initial empty values. We remount the entire form each time the deal
  // id changes by passing a `key={deal?.id}` to the <form>; the new mount
  // picks up the row's values as fresh defaults.

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
              className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
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
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="edit-deal-form"
              disabled={pending}
              className={cn(
                'inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition',
                'hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60',
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
        key={deal?.id ?? 'empty'}
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

        <TextareaField
          name="description"
          label="Description"
          rows={3}
          defaultValue={deal?.description ?? ''}
          errors={fieldErrors.description}
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

        <Field
          name="companyName"
          label="Company"
          defaultValue={deal?.companyName ?? ''}
          errors={fieldErrors.companyName}
        />

        <Field
          name="contactName"
          label="Contact"
          defaultValue={deal?.contactName ?? ''}
          errors={fieldErrors.contactName}
        />

        <Field
          name="contactEmail"
          label="Email"
          type="email"
          defaultValue={deal?.contactEmail ?? ''}
          errors={fieldErrors.contactEmail}
        />

        {canAssign ? (
          <OwnerFormField
            teammates={assignable}
            currentUserId={currentUserId}
            defaultOwnerId={deal?.ownerId ?? null}
            errors={fieldErrors.ownerId}
          />
        ) : null}

        <CustomFieldInputs
          defs={customFieldDefs}
          values={(deal?.customFields ?? {}) as CustomValues}
          errors={customErrors(fieldErrors)}
        />

        {error ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700"
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
  type?: 'text' | 'number' | 'date' | 'email';
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
      <label htmlFor={name} className="text-xs font-medium text-slate-700">
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

type TextareaFieldProps = {
  name: string;
  label: string;
  defaultValue: string;
  rows?: number;
  errors?: string[];
};

function TextareaField({
  name,
  label,
  defaultValue,
  rows = 3,
  errors,
}: TextareaFieldProps) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? `${name}-error` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-slate-700">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        aria-invalid={hasError || undefined}
        aria-describedby={errorId}
        className={cn(
          'rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition resize-y',
          'placeholder:text-slate-400 focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
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
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600">
          {errors!.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
