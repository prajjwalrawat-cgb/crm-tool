'use client';

import { Loader2, Save, Trash2 } from 'lucide-react';

import type { Company } from '@/db/schema';
import type { CustomFieldDef, CustomValues } from '@/lib/custom-fields/types';
import { cn } from '@/lib/utils';

import { CustomFieldInputs } from '../../_components/custom-field-inputs';
import { Drawer } from '../../_components/drawer';
import { Field, SiteAddressFieldset } from './site-address-fieldset';

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

        <SiteAddressFieldset company={company} canPin={canPin} fieldErrors={fieldErrors} />

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
