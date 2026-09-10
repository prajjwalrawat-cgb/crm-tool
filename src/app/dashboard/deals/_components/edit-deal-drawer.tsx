'use client';

import { Loader2, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactPickerOption } from '@/lib/contacts/queries';
import type { CustomFieldDef, CustomValues } from '@/lib/custom-fields/types';
import { marginBpsToPct } from '@/lib/deals/approval';
import { validateDealForm } from '@/lib/deals/client-validate';
import {
  closeDateRequiredForStage,
  isRollbackTransition,
} from '@/lib/deals/stage-governance';
import { fromMinorUnits } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import {
  DEAL_STAGE_LABELS,
  DEAL_STAGES,
  DEAL_TYPE_LABELS,
  DEAL_TYPES,
} from '@/lib/deals/schema';
import {
  offeringRuleFor,
  type OfferingOption,
} from '@/lib/offerings/types';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { CustomFieldInputs } from '../../_components/custom-field-inputs';
import { Drawer } from '../../_components/drawer';
import { OwnerFormField } from '../../_components/owner-form-field';
import { DealAmountFields } from './deal-amount-fields';
import { DealCompanyContactFields } from './deal-company-contact-fields';
import { OfferingsField } from './offerings-field';
import { RollbackReasonModal } from './rollback-reason-modal';

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
  contactOptions: ContactPickerOption[];
  teammates: Teammate[];
  currentUserId: string;
  currentRole: MembershipRole;
  customFieldDefs: CustomFieldDef[];
  unitPricingEnabled: boolean;
  /** Active offerings only — a retired one can't be added to anything new. */
  offeringOptions: OfferingOption[];
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
  teammates,
  currentUserId,
  currentRole,
  customFieldDefs,
  unitPricingEnabled,
  offeringOptions,
  onSubmit,
  onDelete,
  pending,
  deletePending,
  error,
  fieldErrors,
  canDelete,
}: Props) {
  // Client-side validation errors, shown alongside any server fieldErrors.
  // Validating here lets us block the submit BEFORE the server action fires —
  // a rejected round-trip would reset the form and blank the Company/Contact
  // selects (see client-validate.ts).
  const [clientErrors, setClientErrors] = useState<Record<string, string[]>>({});
  const [clientMsg, setClientMsg] = useState<string | null>(null);
  // Stage drives which conditional fields render (lost reason, close date), so
  // it has to track the deal being edited. The `key` further down remounts the
  // <form> — but NOT this component, so a plain `useState(deal.stage)` would be
  // stuck on whatever the first render saw (`lead`, from the closed drawer's
  // `deal=null`) while the select itself showed the real stage. Re-seed it when
  // the drawer switches deals — React's adjust-state-on-prop-change pattern.
  const dealKey = deal?.id ?? null;
  const [stageState, setStageState] = useState<{
    key: string | null;
    value: string;
  }>(() => ({ key: dealKey, value: deal?.stage ?? 'lead' }));
  if (stageState.key !== dealKey) {
    setStageState({ key: dealKey, value: deal?.stage ?? 'lead' });
  }
  const stageValue =
    stageState.key === dealKey ? stageState.value : (deal?.stage ?? 'lead');
  const setStageValue = (value: string) =>
    setStageState({ key: dealKey, value });
  const errs = { ...fieldErrors, ...clientErrors };
  // The stored values the governance rules compare against (R2/R3). Null on a
  // closed drawer, where there is no deal to move backward or blank.
  const previousState = deal
    ? { stage: deal.stage, expectedCloseDate: deal.expectedCloseDate }
    : null;
  const closeDateRequired = closeDateRequiredForStage(stageValue);
  // A backward save, held until the reason modal is answered. Holds the
  // submitted FormData so the confirm path doesn't have to re-read the form.
  const [rollbackPrompt, setRollbackPrompt] = useState<{
    fd: FormData;
    fromStage: string;
  } | null>(null);

  function submitWith(fd: FormData, rollback?: { reason: string; note: string }) {
    // R2 — the confirmed reason rides along as form fields, matching how the
    // action reads it. Set before validation so the rollback check passes.
    if (rollback) {
      fd.set('rollbackReason', rollback.reason);
      if (rollback.note) fd.set('rollbackNote', rollback.note);
    }
    // The rule follows the DEAL's history, not the fact that this is an edit:
    // a deal that already carries tags may be re-tagged but not emptied, while
    // an untagged legacy deal is never blocked. See `offeringRuleFor`.
    const found = validateDealForm(fd, previousState, {
      offeringRule: offeringRuleFor({
        isNewDeal: false,
        existingTagCount: deal?.offerings.length ?? 0,
      }),
    });
    if (Object.keys(found).length > 0) {
      setClientErrors(found);
      setClientMsg('Please fix the highlighted fields.');
      return;
    }
    setClientErrors({});
    setClientMsg(null);
    onSubmit(fd);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    // R2 — a save that moves the deal backward is held until a reason is
    // picked, rather than submitted and bounced. The FormData is captured
    // here because the form resets once its action runs.
    if (
      previousState &&
      isRollbackTransition(previousState.stage, String(fd.get('stage') ?? ''))
    ) {
      setRollbackPrompt({ fd, fromStage: previousState.stage });
      return;
    }

    submitWith(fd);
  }

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
  const initialUnitPrice =
    deal && deal.unitPriceMinor != null
      ? fromMinorUnits(deal.unitPriceMinor, deal.currency).toString()
      : '';
  const initialQuantity =
    deal && deal.quantity != null ? String(deal.quantity) : '';
  const initialMarginPct =
    deal && deal.marginBps != null ? marginBpsToPct(deal.marginBps).toString() : '';
  // A deal that already carries unit price + qty is always unit-priced, even
  // if the workspace later turned the toggle off — so we keep showing the
  // fields (and keep Amount derived) rather than losing that data.
  const dealHasUnitPricing =
    deal != null && deal.unitPriceMinor != null && deal.quantity != null;
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
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
        noValidate
      >
        <input type="hidden" name="id" value={deal?.id ?? ''} />

        <Field
          name="name"
          label="Name"
          required
          defaultValue={deal?.name ?? ''}
          errors={errs.name}
        />

        <TextareaField
          name="description"
          label="Description"
          rows={3}
          defaultValue={deal?.description ?? ''}
          errors={errs.description}
        />

        <Select
          name="stage"
          label="Stage"
          defaultValue={deal?.stage ?? 'lead'}
          errors={errs.stage}
          onChange={setStageValue}
        >
          {DEAL_STAGES.map((s) => (
            <option key={s} value={s}>
              {DEAL_STAGE_LABELS[s]}
            </option>
          ))}
        </Select>

        {stageValue === 'lost' ? (
          <TextareaField
            name="lostReason"
            label="Lost reason *"
            rows={2}
            defaultValue={deal?.lostReason ?? ''}
            errors={errs.lostReason}
          />
        ) : null}

        <Select
          name="dealType"
          label="Deal type"
          defaultValue={deal?.dealType ?? ''}
          errors={errs.dealType}
        >
          <option value="">—</option>
          {DEAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {DEAL_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>

        <DealAmountFields
          stage={stageValue}
          unitPricingEnabled={unitPricingEnabled || dealHasUnitPricing}
          defaultCurrency={deal?.currency ?? 'INR'}
          defaultAmount={initialAmount}
          defaultUnitPrice={initialUnitPrice}
          defaultQuantity={initialQuantity}
          defaultMarginPct={initialMarginPct}
          errors={errs}
        />

        {/* Hidden in Lead — a Lead can't hold a close date (see
            violatesLeadCloseDate). The field submits nothing while hidden,
            which the action reads as null, so switching a dated deal back to
            Lead clears its date on save. */}
        {stageValue === 'lead' ? (
          <p className="text-xs text-slate-500">
            Expected close date is set once the deal reaches Qualified.
            {initialDate
              ? ' Saving in Lead clears the date currently on this deal.'
              : ''}
          </p>
        ) : (
          <Field
            name="expectedCloseDate"
            label="Expected close date"
            type="date"
            defaultValue={initialDate}
            // R1 — mandatory from Proposal on: a deal being quoted with no
            // committed date is unforecastable. `required` also lets the
            // browser block the submit before validateDealForm even runs.
            required={closeDateRequired}
            errors={errs.expectedCloseDate}
          />
        )}

        <DealCompanyContactFields
          key={`cc-${deal?.id ?? 'none'}`}
          companyOptions={companyOptions}
          contactOptions={contactOptions}
          defaultCompanyId={deal?.companyId ?? null}
          defaultContactId={deal?.contactId ?? null}
          companyError={errs.companyId}
          contactError={errs.contactId}
        />

        {/* Offerings (0066). Editable here as well as on the detail page —
            the drawer is where the list edits a deal, and a field reachable
            from only one of the two reads as missing. `key` remounts the
            picker when the drawer switches deals, the same reason the form
            itself is keyed. */}
        <OfferingsField
          key={`off-${deal?.id ?? 'none'}`}
          options={offeringOptions}
          errors={errs.offeringIds}
          required={(deal?.offerings.length ?? 0) > 0}
          defaultSelectedIds={(deal?.offerings ?? []).map((o) => o.id)}
          defaultPrimaryId={
            (deal?.offerings ?? []).find((o) => o.isPrimary)?.id ?? null
          }
          extraOptions={deal?.offerings ?? []}
        />

        {canAssign ? (
          <OwnerFormField
            teammates={assignable}
            currentUserId={currentUserId}
            defaultOwnerId={deal?.ownerId ?? null}
            errors={errs.ownerId}
          />
        ) : null}

        <CustomFieldInputs
          defs={customFieldDefs}
          values={(deal?.customFields ?? {}) as CustomValues}
          errors={customErrors(errs)}
        />

        {error || clientMsg ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error ?? clientMsg}
          </p>
        ) : null}
      </form>

      {rollbackPrompt ? (
        <RollbackReasonModal
          dealName={deal?.name ?? 'this deal'}
          fromStage={rollbackPrompt.fromStage}
          toStage={String(rollbackPrompt.fd.get('stage') ?? '')}
          pending={pending}
          // Cancel abandons the save entirely. The form keeps what the user
          // typed (it hasn't been submitted), so they can pick a different
          // stage or try again — nothing is lost.
          onCancel={() => setRollbackPrompt(null)}
          onConfirm={(reason, note) => {
            submitWith(rollbackPrompt.fd, { reason, note });
            setRollbackPrompt(null);
          }}
        />
      ) : null}
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
  onChange?: (value: string) => void;
  children: React.ReactNode;
};

function Select({ name, label, defaultValue, errors, onChange, children }: SelectProps) {
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
      {hasError ? (
        <p id={errorId} className="text-xs text-red-600">
          {errors!.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
