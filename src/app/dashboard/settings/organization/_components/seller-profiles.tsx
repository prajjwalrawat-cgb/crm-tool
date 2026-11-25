'use client';

import { Landmark, Loader2, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { INDIAN_STATES } from '@/lib/invoices/india-geo';
import type { SellerProfile } from '@/lib/invoices/seller-profiles';

import { SettingsCard, SettingsSection } from '../../_components/settings-form';
import { deleteSellerProfileAction, saveSellerProfileAction } from '../seller-actions';

// Same look as the settings rows (InputRow / SelectRow) above it.
const inputCls =
  'w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50 disabled:text-slate-600 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA] dark:disabled:text-[#A1A1AA]';

/** Input class with a red border when the field has an error. */
function cls(error?: string): string {
  return error ? `${inputCls} border-rose-300 focus:border-rose-500 focus:ring-rose-500/20` : inputCls;
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

/**
 * Seller & bank details per GST state, shared by invoices and quotes.
 * Everyone who can open Organization sees them; only the owner can edit.
 */
export function SellerProfiles({
  profiles: initialProfiles,
  canEdit,
}: {
  profiles: SellerProfile[];
  canEdit: boolean;
}) {
  const [profiles, setProfiles] = useState<SellerProfile[]>(initialProfiles);
  const [activeCode, setActiveCode] = useState<string>(initialProfiles[0]?.stateCode ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startSave] = useTransition();

  const active = profiles.find((p) => p.stateCode === activeCode) ?? null;
  const configured = new Set(profiles.map((p) => p.stateCode));
  const available = INDIAN_STATES.filter((s) => !configured.has(s.code));
  const locked = !canEdit;

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
    setProfiles((prev) => prev.map((p) => (p.stateCode === activeCode ? { ...p, ...patch } : p)));
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
    startSave(async () => {
      const res = await saveSellerProfileAction(active);
      if (res.ok) toast.success(`Saved ${active.stateName} details`);
      else toast.error(res.error);
    });
  }
  function removeActive() {
    if (!active) return;
    const code = active.stateCode;
    if (!confirm(`Remove ${stateName(code)}? New invoices and quotes can no longer use it; existing ones keep their details.`)) return;
    startSave(async () => {
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

  return (
    <SettingsCard>
      <SettingsSection
        title="Seller details by state"
        description="Company, GSTIN, address and bank details for each GST registration (e.g. Delhi, Karnataka). Printed on invoices and quotes; reps pick the state on each one."
        icon={Landmark}
      >
        {locked ? (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-[12px] text-slate-500 dark:bg-[#111111] dark:text-[#A1A1AA]">
            Only the workspace owner can change these.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {profiles.map((p) => (
            <button
              key={p.stateCode}
              type="button"
              onClick={() => selectActive(p.stateCode)}
              className={
                p.stateCode === activeCode
                  ? 'rounded-full bg-indigo-600 px-3 py-1 text-[12px] font-medium text-white'
                  : 'rounded-full border border-slate-200 px-3 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#A1A1AA] dark:hover:bg-[#181818]'
              }
            >
              {p.stateName}
            </button>
          ))}
          {!locked && available.length > 0 ? (
            <select
              value=""
              onChange={(e) => addState(e.target.value)}
              className="rounded-full border border-dashed border-slate-300 bg-white px-3 py-1 text-[12px] text-slate-600 dark:border-[#2A2A2A] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]"
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
          <fieldset disabled={locked} className="space-y-3 border-t border-slate-100 pt-3 dark:border-[#1F1F1F]">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                {active.stateName} <span className="font-normal text-slate-400">· code {active.stateCode}</span>
              </h3>
              {!locked ? (
                <button
                  type="button"
                  onClick={removeActive}
                  disabled={saving}
                  className="inline-flex items-center gap-1 text-[12px] text-red-600 hover:underline disabled:opacity-60"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove state
                </button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Company name" required error={errors.name}>
                <input value={active.name} onChange={(e) => patchActive({ name: e.target.value })} placeholder="Your company name" className={cls(errors.name)} />
              </Field>
              <Field label="GSTIN/UIN" required error={errors.gstin}>
                <input value={active.gstin} onChange={(e) => patchActive({ gstin: e.target.value })} placeholder={`${active.stateCode}ABCDE1234F1Z5`} className={cls(errors.gstin)} />
              </Field>
            </div>
            {!locked ? (
              <p className="text-[11px] text-slate-400">
                GSTIN must start with {active.stateCode} (the {active.stateName} GST code).
              </p>
            ) : null}
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
            {!locked ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={saveActive}
                  disabled={saving}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                  Save {active.stateName}
                </button>
              </div>
            ) : null}
          </fieldset>
        ) : (
          <p className="rounded-md border border-dashed border-slate-200 px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-[#2A2A2A] dark:text-[#A1A1AA]">
            {locked
              ? 'No seller details yet. The workspace owner adds them here.'
              : 'Add a state above to set up seller & bank details.'}
          </p>
        )}
      </SettingsSection>
    </SettingsCard>
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
      <span className="text-[13px] font-medium text-slate-800 dark:text-[#FAFAFA]">
        {label}
        {required ? <span className="text-rose-500"> *</span> : null}
      </span>
      {children}
      {error ? <span className="block text-[11px] text-rose-600">{error}</span> : null}
    </label>
  );
}
