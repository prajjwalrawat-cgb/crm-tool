'use client';

import { Loader2, Save, Trash2 } from 'lucide-react';

import type { Company } from '@/db/schema';
import type { CustomFieldDef, CustomValues } from '@/lib/custom-fields/types';
import { cn } from '@/lib/utils';

import { CustomFieldInputs } from '../../_components/custom-field-inputs';
import { Drawer } from '../../_components/drawer';

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
  company: Company | null;
  customFieldDefs: CustomFieldDef[];
  onSubmit: (formData: FormData) => void;
  onDelete: () => void;
  pending: boolean;
  deletePending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  canDelete: boolean;
  /** `pinFieldSites`: shows the site pin and check-in radius inputs. */
  canPin?: boolean;
};

export function EditCompanyDrawer({
  open,
  onClose,
  company,
  customFieldDefs,
  onSubmit,
  onDelete,
  pending,
  deletePending,
  error,
  fieldErrors,
  canDelete,
  canPin = false,
}: Props) {
  // See edit-deal-drawer.tsx — uncontrolled inputs only pick up
  // `defaultValue` on first mount, so we remount the form whenever
  // company.id changes via a `key` prop on <form>.

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Edit company"
      description={company?.name}
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
              form="edit-company-form"
              disabled={pending}
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition',
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
        id="edit-company-form"
        key={company?.id ?? 'empty'}
        action={onSubmit}
        className="flex flex-col gap-4"
        noValidate
      >
        <input type="hidden" name="id" value={company?.id ?? ''} />

        <Field
          name="name"
          label="Company Name"
          required
          defaultValue={company?.name ?? ''}
          errors={fieldErrors.name}
        />
        <Field
          name="domain"
          label="Domain"
          defaultValue={company?.domain ?? ''}
          errors={fieldErrors.domain}
        />
        <Field
          name="industry"
          label="Industry"
          defaultValue={company?.industry ?? ''}
          errors={fieldErrors.industry}
        />

        <fieldset className="flex flex-col gap-4 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-xs font-semibold text-slate-700">Site address</legend>
          <Field name="address" label="Address" defaultValue={company?.address ?? ''} errors={fieldErrors.address} />
          <div className="grid grid-cols-2 gap-3">
            <Field name="city" label="City" defaultValue={company?.city ?? ''} errors={fieldErrors.city} />
            <Field name="state" label="State" defaultValue={company?.state ?? ''} errors={fieldErrors.state} />
          </div>
          <Field
            name="postalCode"
            label="Postal code"
            defaultValue={company?.postalCode ?? ''}
            errors={fieldErrors.postalCode}
          />
          <p className="text-xs text-slate-500" data-testid="geocode-status">
            {locationSummary(company)}
          </p>
          {canPin ? (
            <>
              <Field
                name="sitePin"
                label="Site pin"
                defaultValue=""
                placeholder="Paste a Google Maps link or lat, lng"
                hint="Optional. Overrides the address lookup; field meetings at this company check in against this point."
                errors={fieldErrors.sitePin}
              />
              <Field
                name="checkinRadiusM"
                label="Check-in radius (m)"
                defaultValue={company?.checkinRadiusM != null ? String(company.checkinRadiusM) : ''}
                placeholder="Workspace default"
                hint="50 to 5000. Leave blank to use the workspace default."
                inputMode="numeric"
                errors={fieldErrors.checkinRadiusM}
              />
            </>
          ) : null}
        </fieldset>

        <CustomFieldInputs
          defs={customFieldDefs}
          values={(company?.customFields ?? {}) as CustomValues}
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

function locationSummary(c: Company | null): string {
  if (!c) return '';
  const has = c.lat !== null && c.lng !== null;
  const coords = has ? ` (${c.lat!.toFixed(5)}, ${c.lng!.toFixed(5)})` : '';
  switch (c.geocodeStatus) {
    case 'manual':
      return `Pinned manually${coords}`;
    case 'ok':
      return `Located${coords}`;
    case 'failed':
      return "Couldn't locate this address. Check it, or paste a site pin.";
    case 'pending':
      return 'Not located yet';
    default:
      return has ? `Located${coords}` : 'Not located yet';
  }
}

type FieldProps = {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
  errors?: string[];
  placeholder?: string;
  hint?: string;
  inputMode?: 'numeric';
};

function Field({ name, label, defaultValue, required, errors, placeholder, hint, inputMode }: FieldProps) {
  const hasError = Boolean(errors?.length);
  const errorId = hasError ? `${name}-error` : undefined;
  const hintId = hint ? `${name}-hint` : undefined;

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
        defaultValue={defaultValue}
        aria-invalid={hasError || undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        placeholder={placeholder}
        inputMode={inputMode}
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
      {hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
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
