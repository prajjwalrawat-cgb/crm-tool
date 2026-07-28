'use client';

import { Loader2, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactPickerOption } from '@/lib/contacts/queries';
import type { CustomFieldDef } from '@/lib/custom-fields/types';
import type { Teammate } from '@/lib/teammates/queries';
import { validateDealForm } from '@/lib/deals/client-validate';
import {
  DEAL_STAGE_LABELS,
  DEAL_STAGES,
  DEAL_TYPE_LABELS,
  DEAL_TYPES,
} from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

import { CustomFieldInputs } from '../../_components/custom-field-inputs';
import { OwnerFormField } from '../../_components/owner-form-field';
import { DealAmountFields } from './deal-amount-fields';
import { DealCompanyContactFields } from './deal-company-contact-fields';

/** Pull `cf_*` errors out of the field-error map (first message each). */
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
  contactOptions: ContactPickerOption[];
  teammates: Teammate[];
  currentUserId: string;
  currentRole: MembershipRole;
  customFieldDefs: CustomFieldDef[];
  unitPricingEnabled: boolean;
};

export function CreateDealForm({
  onSubmit,
  pending,
  error,
  fieldErrors,
  resetKey,
  companyOptions,
  contactOptions,
  teammates,
  currentUserId,
  currentRole,
  customFieldDefs,
  unitPricingEnabled,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  // Client-side validation errors, shown alongside server fieldErrors. We
  // validate before dispatching so an invalid submit never fires the server
  // action (which would reset the form and blank the Company/Contact selects).
  const [clientErrors, setClientErrors] = useState<Record<string, string[]>>({});
  const [clientMsg, setClientMsg] = useState<string | null>(null);
  const [stageValue, setStageValue] = useState('lead');
  const errs = { ...fieldErrors, ...clientErrors };

  useEffect(() => {
    formRef.current?.reset();
    setClientErrors({});
    setClientMsg(null);
    // form.reset() puts the DOM select back to Lead, so the state that mirrors
    // it has to follow — otherwise the next deal's form shows Lead while still
    // rendering the previous stage's conditional fields.
    setStageValue('lead');
  }, [resetKey]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const found = validateDealForm(fd);
    if (Object.keys(found).length > 0) {
      setClientErrors(found);
      setClientMsg('Please fix the highlighted fields.');
      return;
    }
    setClientErrors({});
    setClientMsg(null);
    onSubmit(fd);
  }

  // Only owner + manager can assign a deal to someone else. A manager may
  // not assign to an owner, so they get the team minus owners.
  const canAssign = currentRole === 'owner' || currentRole === 'manager';
  const assignable =
    currentRole === 'owner'
      ? teammates
      : teammates.filter((t) => t.role !== 'owner');

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
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
        errors={errs.name}
      />

      <TextareaField
        name="description"
        label="Description"
        placeholder="Decision criteria, blockers, next steps…"
        rows={3}
        errors={errs.description}
      />

      <SelectField
        name="stage"
        label="Stage"
        errors={errs.stage}
        defaultValue="lead"
        onChange={setStageValue}
      >
        {DEAL_STAGES.map((stage) => (
          <option key={stage} value={stage}>
            {DEAL_STAGE_LABELS[stage]}
          </option>
        ))}
      </SelectField>

      {stageValue === 'lost' ? (
        <TextareaField
          name="lostReason"
          label="Lost reason *"
          placeholder="Why was this deal lost?"
          rows={2}
          errors={errs.lostReason}
        />
      ) : null}

      <SelectField
        name="dealType"
        label="Deal type"
        errors={errs.dealType}
        defaultValue=""
        emptyHint="Distinguishes same-named deals on the board (optional)."
      >
        <option value="">—</option>
        {DEAL_TYPES.map((t) => (
          <option key={t} value={t}>
            {DEAL_TYPE_LABELS[t]}
          </option>
        ))}
      </SelectField>

      <DealAmountFields
        unitPricingEnabled={unitPricingEnabled}
        defaultCurrency="INR"
        defaultAmount="0"
        errors={errs}
      />

      {/* A Lead can't carry a close date (see violatesLeadCloseDate), so the
          field is hidden rather than shown-and-rejected. Nothing is submitted
          for it while hidden, which the action reads as null. */}
      {stageValue === 'lead' ? (
        <p className="text-xs text-slate-500">
          Expected close date is set once the deal reaches Qualified.
        </p>
      ) : (
        <Field
          name="expectedCloseDate"
          label="Expected close date"
          type="date"
          errors={errs.expectedCloseDate}
        />
      )}

      <DealCompanyContactFields
        companyOptions={companyOptions}
        contactOptions={contactOptions}
        companyError={errs.companyId}
        contactError={errs.contactId}
      />

      {canAssign ? (
        <OwnerFormField
          teammates={assignable}
          currentUserId={currentUserId}
          errors={errs.ownerId}
        />
      ) : (
        // Members/admins can't reassign — their new deal is owned by them.
        <input type="hidden" name="ownerId" value={currentUserId} />
      )}

      <CustomFieldInputs defs={customFieldDefs} errors={customErrors(errs)} />

      {error || clientMsg ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error ?? clientMsg}
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
  type?: 'text' | 'number' | 'date' | 'email';
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

type TextareaFieldProps = {
  name: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  rows?: number;
  errors?: string[];
};

function TextareaField({
  name,
  label,
  placeholder,
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
        placeholder={placeholder}
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

type SelectFieldProps = {
  name: string;
  label: string;
  defaultValue: string;
  errors?: string[];
  emptyHint?: string;
  onChange?: (value: string) => void;
  children: React.ReactNode;
};

function SelectField({
  name,
  label,
  defaultValue,
  errors,
  emptyHint,
  onChange,
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
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
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
