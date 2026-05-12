'use client';

import { Loader2 } from 'lucide-react';
import { useRef } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactOption } from '@/lib/contacts/queries';
import { cn } from '@/lib/utils';

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const STATUSES = ['todo', 'in_progress', 'completed', 'cancelled'] as const;

export function CreateTaskForm({
  onSubmit,
  pending,
  error,
  fieldErrors,
  resetKey,
  companyOptions,
  contactOptions,
  currentUserId,
}: {
  onSubmit: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  resetKey: number;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  currentUserId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      key={resetKey}
      action={(fd) => {
        onSubmit(fd);
      }}
      className="flex flex-col gap-4"
    >
      <TextField
        name="title"
        label="Title"
        placeholder="Follow up with Razorpay on Q3 renewal"
        autoFocus
        errors={fieldErrors.title}
        required
      />

      <Field label="Description" errors={fieldErrors.description}>
        <textarea
          name="description"
          rows={3}
          placeholder="Optional — context, links, expected outcome"
          className="resize-y rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <SelectField name="priority" label="Priority" defaultValue="medium" errors={fieldErrors.priority}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p[0]!.toUpperCase() + p.slice(1)}
            </option>
          ))}
        </SelectField>
        <SelectField name="status" label="Status" defaultValue="todo" errors={fieldErrors.status}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'in_progress'
                ? 'In progress'
                : s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          name="dueDate"
          label="Due date"
          type="date"
          errors={fieldErrors.dueDate}
        />
        <TextField
          name="assignedUserId"
          label="Assignee"
          defaultValue={currentUserId}
          placeholder="User id (defaults to you)"
          errors={fieldErrors.assignedUserId}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SelectField name="entityType" label="Linked to" defaultValue="" errors={fieldErrors.entityType}>
          <option value="">— None —</option>
          <option value="deal">Deal</option>
          <option value="company">Company</option>
          <option value="contact">Contact</option>
        </SelectField>
        <Field label="Entity" errors={fieldErrors.entityId}>
          <select
            name="entityId"
            defaultValue=""
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          >
            <option value="">— Pick one —</option>
            {companyOptions.slice(0, 200).map((c) => (
              <option key={`co-${c.id}`} value={c.id}>
                Company: {c.name}
              </option>
            ))}
            {contactOptions.slice(0, 200).map((c) => (
              <option key={`ct-${c.id}`} value={c.id}>
                Contact: {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        Create task
      </button>
    </form>
  );
}

function Field({
  label,
  errors,
  children,
}: {
  label: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {children}
      {errors?.length ? (
        <p className="text-[11px] text-rose-600">{errors.join(' ')}</p>
      ) : null}
    </div>
  );
}

function TextField({
  name,
  label,
  type = 'text',
  placeholder,
  defaultValue,
  autoFocus,
  required,
  errors,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  defaultValue?: string;
  autoFocus?: boolean;
  required?: boolean;
  errors?: string[];
}) {
  const hasError = Boolean(errors?.length);
  return (
    <Field label={label} errors={errors}>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        autoFocus={autoFocus}
        required={required}
        className={cn(
          'rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition',
          'placeholder:text-slate-400 focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
        )}
      />
    </Field>
  );
}

function SelectField({
  name,
  label,
  defaultValue,
  errors,
  children,
}: {
  name: string;
  label: string;
  defaultValue: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  const hasError = Boolean(errors?.length);
  return (
    <Field label={label} errors={errors}>
      <select
        name={name}
        defaultValue={defaultValue}
        className={cn(
          'rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
        )}
      >
        {children}
      </select>
    </Field>
  );
}
