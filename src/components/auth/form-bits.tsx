'use client';

import type { InputHTMLAttributes, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

const inputClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 ' +
  'outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ' +
  'dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA]';

export function Field({
  label,
  name,
  type = 'text',
  ...props
}: { label: string; name: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-slate-700 dark:text-[#A1A1AA]">
        {label}
      </span>
      <input name={name} type={type} className={inputClass} {...props} />
    </label>
  );
}

export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-3 py-2 text-[13.5px] font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Please wait…' : children}
    </button>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
      {message}
    </p>
  );
}

export function FormNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
      {children}
    </p>
  );
}
