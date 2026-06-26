'use client';

import { ImageIcon, Loader2, Upload } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  removeInvoiceLogoAction,
  saveInvoiceSettingsAction,
  uploadInvoiceLogoAction,
} from '../actions';

export type InvoiceSettingsValues = {
  logoUrl: string;
  sellerName: string;
  sellerAddress: string;
  gstin: string;
  pan: string;
  cin: string;
  bankName: string;
  bankAccount: string;
  bankIfsc: string;
  bankBranch: string;
  paymentTerms: string;
  deliveryTerms: string;
};

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA]';

export function InvoiceSettingsForm({ initial }: { initial: InvoiceSettingsValues }) {
  const [v, setV] = useState<InvoiceSettingsValues>(initial);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const set = (patch: Partial<InvoiceSettingsValues>) => setV((p) => ({ ...p, ...patch }));

  function save() {
    startTransition(async () => {
      const res = await saveInvoiceSettingsAction(v);
      if (res.ok) toast.success('Invoice settings saved');
      else toast.error(res.error);
    });
  }

  async function handleLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    const res = await uploadInvoiceLogoAction(fd);
    setUploading(false);
    if (res.ok) {
      set({ logoUrl: res.url });
      toast.success('Logo saved');
    } else {
      toast.error(res.error);
    }
  }

  function removeLogo() {
    setUploading(true);
    startTransition(async () => {
      const res = await removeInvoiceLogoAction();
      setUploading(false);
      if (res.ok) {
        set({ logoUrl: '' });
        toast.success('Logo removed');
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-5">
      <Section title="Logo">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            {v.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={v.logoUrl} alt="Workspace logo" className="h-full w-full object-contain" />
            ) : (
              <ImageIcon className="h-6 w-6 text-slate-300" aria-hidden />
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#FAFAFA] dark:hover:bg-[#181818]">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
                {v.logoUrl ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleLogo} disabled={uploading} />
              </label>
              {v.logoUrl ? (
                <button type="button" onClick={removeLogo} disabled={uploading} className="text-[12px] text-red-600 hover:underline disabled:opacity-60">
                  Remove
                </button>
              ) : null}
            </div>
            <p className="text-[11px] text-slate-400">PNG, JPG or WebP, up to 2 MB. Shown top-left on the PDF.</p>
          </div>
        </div>
      </Section>

      <Section title="Seller (your company)">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name">
            <input value={v.sellerName} onChange={(e) => set({ sellerName: e.target.value })} placeholder="Your company name" className={inputCls} />
          </Field>
          <Field label="GSTIN/UIN">
            <input value={v.gstin} onChange={(e) => set({ gstin: e.target.value })} placeholder="29ABCDE1234F1Z5" className={inputCls} />
          </Field>
        </div>
        <Field label="Address">
          <textarea value={v.sellerAddress} onChange={(e) => set({ sellerAddress: e.target.value })} rows={3} placeholder="Full address — street, area, city, state, pincode" className={inputCls} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PAN"><input value={v.pan} onChange={(e) => set({ pan: e.target.value })} placeholder="ABCDE1234F" className={inputCls} /></Field>
          <Field label="CIN"><input value={v.cin} onChange={(e) => set({ cin: e.target.value })} placeholder="U12345KA…" className={inputCls} /></Field>
        </div>
      </Section>

      <Section title="Bank details">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bank name"><input value={v.bankName} onChange={(e) => set({ bankName: e.target.value })} placeholder="Axis Bank" className={inputCls} /></Field>
          <Field label="A/c No."><input value={v.bankAccount} onChange={(e) => set({ bankAccount: e.target.value })} placeholder="Account number" className={inputCls} /></Field>
          <Field label="IFSC"><input value={v.bankIfsc} onChange={(e) => set({ bankIfsc: e.target.value })} placeholder="UTIB0000009" className={inputCls} /></Field>
          <Field label="Branch"><input value={v.bankBranch} onChange={(e) => set({ bankBranch: e.target.value })} placeholder="Branch" className={inputCls} /></Field>
        </div>
      </Section>

      <Section title="Default terms">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment terms"><input value={v.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} placeholder="50% advance and 50% before dispatch" className={inputCls} /></Field>
          <Field label="Delivery terms"><input value={v.deliveryTerms} onChange={(e) => set({ deliveryTerms: e.target.value })} placeholder="7–10 working days" className={inputCls} /></Field>
        </div>
      </Section>

      <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-[#1F1F1F]">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-indigo-500 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Save settings
        </button>
      </div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-slate-600 dark:text-[#A1A1AA]">{label}</span>
      {children}
    </label>
  );
}
