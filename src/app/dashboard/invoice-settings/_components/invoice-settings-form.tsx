'use client';

import { ImageIcon, Landmark, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { saveWorkspaceTermsAction } from '../actions';

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA]';

const ORG_SETTINGS = '/dashboard/settings/organization';

export function InvoiceSettingsForm({
  logoUrl,
  paymentTerms,
  deliveryTerms,
  sellerStates,
}: {
  logoUrl: string;
  paymentTerms: string;
  deliveryTerms: string;
  /** Names of the states with seller details (set in Settings → Organization). */
  sellerStates: string[];
}) {
  // Default terms (workspace-wide)
  const [terms, setTerms] = useState({ paymentTerms, deliveryTerms });
  const [savingTerms, startTerms] = useTransition();

  function saveTerms() {
    startTerms(async () => {
      const res = await saveWorkspaceTermsAction(terms);
      if (res.ok) toast.success('Default terms saved');
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-5">
      {/* Logo and seller details live in Settings → Organization, shared with quotes */}
      <Section title="Logo & seller details">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Workspace logo" className="h-full w-full object-contain" />
            ) : (
              <ImageIcon className="h-6 w-6 text-slate-300" aria-hidden />
            )}
          </div>
          <div className="space-y-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            <p className="flex items-center gap-1.5">
              <Landmark className="h-3.5 w-3.5" aria-hidden />
              {sellerStates.length > 0
                ? `Seller details set for ${sellerStates.join(', ')}.`
                : 'No seller details yet. Invoices need at least one state.'}
            </p>
            <p>
              The logo and seller &amp; bank details per state are shared by invoices and quotes. Change them in{' '}
              <Link href={ORG_SETTINGS} className="font-medium text-indigo-600 hover:underline">
                Settings → Organization
              </Link>
              .
            </p>
          </div>
        </div>
      </Section>

      {/* Default terms */}
      <Section title="Default terms">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment terms"><input value={terms.paymentTerms} onChange={(e) => setTerms((t) => ({ ...t, paymentTerms: e.target.value }))} placeholder="50% advance and 50% before dispatch" className={inputCls} /></Field>
          <Field label="Delivery terms"><input value={terms.deliveryTerms} onChange={(e) => setTerms((t) => ({ ...t, deliveryTerms: e.target.value }))} placeholder="7–10 working days" className={inputCls} /></Field>
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={saveTerms} disabled={savingTerms} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            {savingTerms ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Save terms
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <h2 className="mb-3 text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-slate-600 dark:text-[#A1A1AA]">
        {label}
        {required ? <span className="text-rose-500"> *</span> : null}
      </span>
      {children}
      {error ? <span className="block text-[11px] text-rose-600">{error}</span> : null}
    </label>
  );
}
