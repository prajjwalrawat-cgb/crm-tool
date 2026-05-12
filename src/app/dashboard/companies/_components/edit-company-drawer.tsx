'use client';

import { Loader2, Save, Trash2 } from 'lucide-react';

import type { Company } from '@/db/schema';
import { cn } from '@/lib/utils';

import { Drawer } from '../../_components/drawer';

type Props = {
  open: boolean;
  onClose: () => void;
  company: Company | null;
  onSubmit: (formData: FormData) => void;
  onDelete: () => void;
  pending: boolean;
  deletePending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  canDelete: boolean;
};

export function EditCompanyDrawer({
  open,
  onClose,
  company,
  onSubmit,
  onDelete,
  pending,
  deletePending,
  error,
  fieldErrors,
  canDelete,
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
          label="Name"
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
  required?: boolean;
  errors?: string[];
};

function Field({ name, label, defaultValue, required, errors }: FieldProps) {
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
        defaultValue={defaultValue}
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
