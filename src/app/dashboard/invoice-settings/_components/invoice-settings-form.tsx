'use client';

import { ImageIcon, Loader2, Trash2, Upload } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { INDIAN_STATES } from '@/lib/invoices/india-geo';
import type { SellerProfile } from '@/lib/invoices/seller-profiles';

import {
  deleteSellerProfileAction,
  removeInvoiceLogoAction,
  saveSellerProfileAction,
  saveWorkspaceTermsAction,
  uploadInvoiceLogoAction,
} from '../actions';

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA]';

/** Input class with a red border when the field has an error. */
function cls(error?: string): string {
  return error
    ? `${inputCls} border-rose-300 focus:border-rose-500 focus:ring-rose-500/20`
    : inputCls;
}

function stateName(code: string): string {
  return INDIAN_STATES.find((s) => s.code === code)?.name ?? code;
}

// Fields required before a state profile can be saved (CIN stays optional).
const REQUIRED_FIELDS: { key: keyof SellerProfile; label: string }[] = [
  { key: 'name', label: 'Company name' },
  { key: 'gstin', label: 'GSTIN' },
  { key: 'address', label: 'Address' },
  { key: 'pan', label: 'PAN' },
  { key: 'bankName', label: 'Bank name' },
  { key: 'bankAccount', label: 'A/c number' },
  { key: 'bankIfsc', label: 'IFSC' },
  { key: 'bankBranch', label: 'Branch' },
];

function validateProfile(p: SellerProfile): Record<string, string> {
  const e: Record<string, string> = {};
  for (const { key, label } of REQUIRED_FIELDS) {
    if (!String(p[key] ?? '').trim()) e[key] = `${label} is required`;
  }
  if (p.gstin.trim() && p.gstin.trim().slice(0, 2) !== p.stateCode) {
    e.gstin = `GSTIN must start with ${p.stateCode}`;
  }
  return e;
}

function emptyProfile(code: string): SellerProfile {
  return {
    stateCode: code,
    stateName: stateName(code),
    name: '',
    address: '',
    gstin: '',
    pan: '',
    cin: '',
    bankName: '',
    bankAccount: '',
    bankIfsc: '',
    bankBranch: '',
  };
}

export function InvoiceSettingsForm({
  logoUrl,
  paymentTerms,
  deliveryTerms,
  profiles: initialProfiles,
}: {
  logoUrl: string;
  paymentTerms: string;
  deliveryTerms: string;
  profiles: SellerProfile[];
}) {
  // Logo (workspace-wide, persists on upload/remove)
  const [logo, setLogo] = useState(logoUrl);
  const [uploading, setUploading] = useState(false);

  // Default terms (workspace-wide)
  const [terms, setTerms] = useState({ paymentTerms, deliveryTerms });
  const [savingTerms, startTerms] = useTransition();

  // Per-state seller profiles
  const [profiles, setProfiles] = useState<SellerProfile[]>(initialProfiles);
  const [activeCode, setActiveCode] = useState<string>(
    initialProfiles[0]?.stateCode ?? '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingProfile, startProfile] = useTransition();

  const active = profiles.find((p) => p.stateCode === activeCode) ?? null;
  const configured = new Set(profiles.map((p) => p.stateCode));
  const available = INDIAN_STATES.filter((s) => !configured.has(s.code));

  function selectActive(code: string) {
    setActiveCode(code);
    setErrors({});
  }
  function addState(code: string) {
    if (!code) return;
    setProfiles((prev) => [...prev, emptyProfile(code)]);
    selectActive(code);
  }
  function patchActive(patch: Partial<SellerProfile>) {
    setProfiles((prev) =>
      prev.map((p) => (p.stateCode === activeCode ? { ...p, ...patch } : p)),
    );
    setErrors((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
  }
  function saveActive() {
    if (!active) return;
    const e = validateProfile(active);
    if (Object.keys(e).length > 0) {
      setErrors(e);
      toast.error('Please fill all required fields.');
      return;
    }
    setErrors({});
    startProfile(async () => {
      const res = await saveSellerProfileAction(active);
      if (res.ok) toast.success(`Saved ${active.stateName} details`);
      else toast.error(res.error);
    });
  }
  function removeActive() {
    if (!active) return;
    const code = active.stateCode;
    startProfile(async () => {
      const res = await deleteSellerProfileAction(code);
      if (res.ok) {
        const remaining = profiles.filter((p) => p.stateCode !== code);
        setProfiles(remaining);
        selectActive(remaining[0]?.stateCode ?? '');
        toast.success(`Removed ${stateName(code)}`);
      } else {
        toast.error(res.error);
      }
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
      setLogo(res.url);
      toast.success('Logo saved');
    } else {
      toast.error(res.error);
    }
  }
  function removeLogo() {
    setUploading(true);
    startProfile(async () => {
      const res = await removeInvoiceLogoAction();
      setUploading(false);
      if (res.ok) {
        setLogo('');
        toast.success('Logo removed');
      } else {
        toast.error(res.error);
      }
    });
  }

  function saveTerms() {
    startTerms(async () => {
      const res = await saveWorkspaceTermsAction(terms);
      if (res.ok) toast.success('Default terms saved');
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-5">
      {/* Logo */}
      <Section title="Logo">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="Workspace logo" className="h-full w-full object-contain" />
            ) : (
              <ImageIcon className="h-6 w-6 text-slate-300" aria-hidden />
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#FAFAFA] dark:hover:bg-[#181818]">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
                {logo ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleLogo} disabled={uploading} />
              </label>
              {logo ? (
                <button type="button" onClick={removeLogo} disabled={uploading} className="text-[12px] text-red-600 hover:underline disabled:opacity-60">
                  Remove
                </button>
              ) : null}
            </div>
            <p className="text-[11px] text-slate-400">PNG, JPG or WebP, up to 2 MB. Shown top-left on every PI.</p>
          </div>
        </div>
      </Section>

      {/* Seller profiles per state */}
      <Section title="Seller details by state">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {profiles.map((p) => (
            <button
              key={p.stateCode}
              type="button"
              onClick={() => selectActive(p.stateCode)}
              className={
                p.stateCode === activeCode
                  ? 'rounded-full bg-indigo-600 px-3 py-1 text-[12px] font-medium text-white'
                  : 'rounded-full border border-slate-200 px-3 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50'
              }
            >
              {p.stateName}
            </button>
          ))}
          {available.length > 0 ? (
            <select
              value=""
              onChange={(e) => addState(e.target.value)}
              className="rounded-full border border-dashed border-slate-300 bg-white px-3 py-1 text-[12px] text-slate-600"
            >
              <option value="">+ Add a state</option>
              {available.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {active ? (
          <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-[#1F1F1F]">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                {active.stateName} <span className="text-slate-400">· code {active.stateCode}</span>
              </h3>
              <button type="button" onClick={removeActive} disabled={savingProfile} className="inline-flex items-center gap-1 text-[12px] text-red-600 hover:underline disabled:opacity-60">
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove state
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Company name" required error={errors.name}>
                <input value={active.name} onChange={(e) => patchActive({ name: e.target.value })} placeholder="Your company name" className={cls(errors.name)} />
              </Field>
              <Field label="GSTIN/UIN" required error={errors.gstin}>
                <input value={active.gstin} onChange={(e) => patchActive({ gstin: e.target.value })} placeholder={`${active.stateCode}ABCDE1234F1Z5`} className={cls(errors.gstin)} />
              </Field>
            </div>
            <p className="text-[11px] text-slate-400">GSTIN must start with {active.stateCode} (the {active.stateName} GST code).</p>
            <Field label="Address" required error={errors.address}>
              <textarea value={active.address} onChange={(e) => patchActive({ address: e.target.value })} rows={3} placeholder="Full address — street, area, city, state, pincode" className={cls(errors.address)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="PAN" required error={errors.pan}><input value={active.pan} onChange={(e) => patchActive({ pan: e.target.value })} placeholder="ABCDE1234F" className={cls(errors.pan)} /></Field>
              <Field label="CIN"><input value={active.cin} onChange={(e) => patchActive({ cin: e.target.value })} placeholder="U12345KA… (optional)" className={inputCls} /></Field>
              <Field label="Bank name" required error={errors.bankName}><input value={active.bankName} onChange={(e) => patchActive({ bankName: e.target.value })} placeholder="Axis Bank" className={cls(errors.bankName)} /></Field>
              <Field label="A/c No." required error={errors.bankAccount}><input value={active.bankAccount} onChange={(e) => patchActive({ bankAccount: e.target.value })} placeholder="Account number" className={cls(errors.bankAccount)} /></Field>
              <Field label="IFSC" required error={errors.bankIfsc}><input value={active.bankIfsc} onChange={(e) => patchActive({ bankIfsc: e.target.value })} placeholder="UTIB0000009" className={cls(errors.bankIfsc)} /></Field>
              <Field label="Branch" required error={errors.bankBranch}><input value={active.bankBranch} onChange={(e) => patchActive({ bankBranch: e.target.value })} placeholder="Branch" className={cls(errors.bankBranch)} /></Field>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={saveActive}
                disabled={savingProfile}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-indigo-500 disabled:opacity-60"
              >
                {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save {active.stateName}
              </button>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-[13px] text-slate-500">
            Add a state above to set up seller &amp; bank details.
          </p>
        )}
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
