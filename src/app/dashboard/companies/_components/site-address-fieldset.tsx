'use client';

import type { Company } from '@/db/schema';
import { cn } from '@/lib/utils';

/**
 * Field Meetings site block shared by the Add and Edit company forms: address,
 * city, state, postal code for anyone who can create / edit companies; site pin
 * and check-in radius only with `pinFieldSites` (the server ignores them from
 * anyone else). `company` null = a new company (no location line yet).
 */
export function SiteAddressFieldset({
  company,
  canPin,
  fieldErrors,
}: {
  company: Company | null;
  canPin: boolean;
  fieldErrors: Record<string, string[]>;
}) {
  return (
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
      {company ? (
        <p className="text-xs text-slate-500" data-testid="geocode-status">
          {locationSummary(company)}
        </p>
      ) : null}
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
  );
}

function locationSummary(c: Company): string {
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

/** Uncontrolled text input with label, hint and errors (company forms). */
export function Field({ name, label, defaultValue, required, errors, placeholder, hint, inputMode }: FieldProps) {
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
