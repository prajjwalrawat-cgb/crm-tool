'use client';

import { ImagePlus, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  createInvoiceAction,
  updateInvoiceAction,
  uploadInvoiceItemImageAction,
} from '@/lib/invoices/actions';
import { compressImage } from '@/lib/invoices/compress';
import type { InvoicePdfData, PdfParty, PdfSeller } from '@/lib/invoices/types';
import {
  ALL_CITIES,
  citiesFor,
  INDIAN_STATES,
  localitiesFor,
  pincodeForLocality,
  stateCodeFor,
  uniqueStateForCity,
} from '@/lib/invoices/india-geo';
import { computeTotals, formatMoneyMinor } from '@/lib/invoices/money';
import { createInvoiceSchema } from '@/lib/invoices/schema';

type PartyFields = {
  name: string;
  address: string;
  city: string;
  locality: string;
  pincode: string;
  gstin: string;
  state: string;
  stateCode: string;
};
type SellerFields = PartyFields & {
  pan: string;
  cin: string;
  bankName: string;
  bankAccount: string;
  bankIfsc: string;
  bankBranch: string;
};
type ItemRow = {
  description: string;
  hsnSac: string;
  unit: string;
  quantity: string;
  rate: string;
  imageUrl?: string;
  __uploading?: boolean;
};

const emptyParty: PartyFields = { name: '', address: '', city: '', locality: '', pincode: '', gstin: '', state: '', stateCode: '' };
// Empty unit/qty/rate so placeholders stay visible; defaults are applied on submit.
const emptyItem: ItemRow = { description: '', hsnSac: '', unit: '', quantity: '', rate: '' };

function partyFromInitial(p?: PdfParty | null): PartyFields {
  return {
    name: p?.name ?? '',
    address: p?.address ?? '',
    city: p?.city ?? '',
    locality: p?.locality ?? '',
    pincode: p?.pincode ?? '',
    gstin: p?.gstin ?? '',
    state: p?.state ?? '',
    stateCode: p?.stateCode ?? '',
  };
}
function sellerFromInitial(s?: PdfSeller | null): SellerFields {
  return {
    ...partyFromInitial(s),
    pan: s?.pan ?? '',
    cin: s?.cin ?? '',
    bankName: s?.bankName ?? '',
    bankAccount: s?.bankAccount ?? '',
    bankIfsc: s?.bankIfsc ?? '',
    bankBranch: s?.bankBranch ?? '',
  };
}
function itemsFromInitial(data?: InvoicePdfData | null): ItemRow[] {
  if (!data || data.items.length === 0) return [{ ...emptyItem }];
  return data.items.map((it) => ({
    description: it.description,
    hsnSac: it.hsnSac ?? '',
    unit: it.unit,
    quantity: String(it.quantity),
    rate: String(it.rateMinor / 100),
    imageUrl: it.imageUrl ?? undefined,
  }));
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function InvoiceForm({
  onSuccess,
  mode = 'create',
  invoiceId,
  initial = null,
}: {
  /** Called after a successful create/update (parent closes drawer + refreshes). */
  onSuccess?: () => void;
  mode?: 'create' | 'edit';
  /** Required when mode === 'edit'. */
  invoiceId?: string;
  /** Existing invoice to prefill in edit mode. */
  initial?: InvoicePdfData | null;
}) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [seller, setSeller] = useState<SellerFields>(() =>
    sellerFromInitial(initial?.seller),
  );
  const [buyer, setBuyer] = useState<PartyFields>(() =>
    partyFromInitial(initial?.buyer),
  );
  const [sameConsignee, setSameConsignee] = useState(() => !initial?.consignee);
  const [consignee, setConsignee] = useState<PartyFields>(() =>
    partyFromInitial(initial?.consignee),
  );

  const [piDate, setPiDate] = useState(() => initial?.piDate ?? today());
  const currency = 'INR'; // invoices are INR-only
  const [taxRate, setTaxRate] = useState(() =>
    initial ? String(Number(initial.taxRate)) : '18',
  );
  const [paymentTerms, setPaymentTerms] = useState(() => initial?.paymentTerms ?? '');
  const [deliveryTerms, setDeliveryTerms] = useState(() => initial?.deliveryTerms ?? '');
  const [notes, setNotes] = useState(() => initial?.notes ?? '');
  const [items, setItems] = useState<ItemRow[]>(() => itemsFromInitial(initial));

  const totals = useMemo(
    () =>
      computeTotals(
        items.map((it) => ({ quantity: Number(it.quantity) || 0, rate: Number(it.rate) || 0 })),
        Number(taxRate) || 0,
      ),
    [items, taxRate],
  );

  function patchItem(idx: number, patch: Partial<ItemRow>) {
    setItems((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function handleImage(idx: number, file: File) {
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file.');
      return;
    }
    patchItem(idx, { __uploading: true });
    try {
      const blob = await compressImage(file);
      const fd = new FormData();
      fd.append('file', new File([blob], 'item.jpg', { type: 'image/jpeg' }));
      const res = await uploadInvoiceItemImageAction(fd);
      if (res.ok) {
        patchItem(idx, { imageUrl: res.url, __uploading: false });
      } else {
        toast.error(res.error);
        patchItem(idx, { __uploading: false });
      }
    } catch {
      toast.error('Could not process the image.');
      patchItem(idx, { __uploading: false });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload = {
      piDate,
      currency,
      taxRate,
      seller,
      buyer,
      consigneeSameAsBuyer: sameConsignee,
      consignee: sameConsignee ? undefined : consignee,
      paymentTerms,
      deliveryTerms,
      notes,
      items: items.map((it) => ({
        description: it.description,
        hsnSac: it.hsnSac,
        unit: it.unit || 'No',
        quantity: it.quantity,
        rate: it.rate,
        imageUrl: it.imageUrl,
      })),
    };

    const result = createInvoiceSchema.safeParse(payload);
    if (!result.success) {
      const map: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.');
        if (!map[key]) map[key] = issue.message;
      }
      setErrors(map);
      setFormError('Please fix the highlighted fields.');
      return;
    }
    setErrors({});

    startTransition(async () => {
      if (mode === 'edit' && invoiceId) {
        const res = await updateInvoiceAction(invoiceId, result.data);
        if (res.ok) {
          toast.success('Invoice updated');
          onSuccess?.();
        } else {
          setFormError(res.error);
          toast.error(res.error);
        }
      } else {
        const res = await createInvoiceAction(result.data);
        if (res.ok) {
          toast.success(`Created ${res.piNumber}`);
          onSuccess?.();
        } else {
          setFormError(res.error);
          toast.error(res.error);
        }
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {formError ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">
          {formError}
        </p>
      ) : null}

      <Section title="Invoice details">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date" error={errors['piDate']}>
            <input type="date" value={piDate} onChange={(e) => setPiDate(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Currency">
            <input value={currency} readOnly aria-readonly className={`${inputCls} bg-slate-50 text-slate-500`} />
          </Field>
          <Field label="GST %" error={errors['taxRate']}>
            <input type="number" min={0} max={100} step="0.01" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="18" className={inputCls} />
          </Field>
        </div>
      </Section>

      <Section title="Seller (your company)">
        <PartyInputs value={seller} onChange={(p) => setSeller({ ...seller, ...p })} errors={errors} prefix="seller" namePlaceholder="Your company name" />
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="PAN"><input value={seller.pan} onChange={(e) => setSeller({ ...seller, pan: e.target.value })} placeholder="ABCDE1234F" className={inputCls} /></Field>
          <Field label="CIN"><input value={seller.cin} onChange={(e) => setSeller({ ...seller, cin: e.target.value })} placeholder="U12345KA…" className={inputCls} /></Field>
          <Field label="Bank name"><input value={seller.bankName} onChange={(e) => setSeller({ ...seller, bankName: e.target.value })} placeholder="Axis Bank" className={inputCls} /></Field>
          <Field label="Bank A/c No."><input value={seller.bankAccount} onChange={(e) => setSeller({ ...seller, bankAccount: e.target.value })} placeholder="Account number" className={inputCls} /></Field>
          <Field label="IFSC"><input value={seller.bankIfsc} onChange={(e) => setSeller({ ...seller, bankIfsc: e.target.value })} placeholder="UTIB0000009" className={inputCls} /></Field>
          <Field label="Branch"><input value={seller.bankBranch} onChange={(e) => setSeller({ ...seller, bankBranch: e.target.value })} placeholder="Branch" className={inputCls} /></Field>
        </div>
      </Section>

      <Section title="Buyer (Bill to)">
        <PartyInputs value={buyer} onChange={(p) => setBuyer({ ...buyer, ...p })} errors={errors} prefix="buyer" namePlaceholder="Buyer / company name" />
      </Section>

      <Section title="Consignee (Ship to)">
        <label className="mb-3 flex items-center gap-2 text-[13px] text-slate-700">
          <input type="checkbox" checked={sameConsignee} onChange={(e) => setSameConsignee(e.target.checked)} />
          Same as buyer
        </label>
        {!sameConsignee ? (
          <PartyInputs value={consignee} onChange={(p) => setConsignee({ ...consignee, ...p })} errors={errors} prefix="consignee" namePlaceholder="Consignee name" />
        ) : null}
      </Section>

      <Section title="Line items">
        {errors['items'] ? <p className="mb-2 text-[12px] text-rose-600">{errors['items']}</p> : null}
        <div className="space-y-3">
          {items.map((it, idx) => {
            const amt = (Number(it.quantity) || 0) * Math.round((Number(it.rate) || 0) * 100);
            return (
              <div key={idx} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-start gap-3">
                  <ImageCell
                    item={it}
                    onPick={(file) => handleImage(idx, file)}
                    onClear={() => patchItem(idx, { imageUrl: undefined })}
                  />
                  <div className="flex-1 space-y-2">
                    <input
                      value={it.description}
                      onChange={(e) => patchItem(idx, { description: e.target.value })}
                      placeholder="Item / service description"
                      className={cellCls}
                    />
                    {errors[`items.${idx}.description`] ? (
                      <span className="block text-[11px] text-rose-600">{errors[`items.${idx}.description`]}</span>
                    ) : null}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <input value={it.hsnSac} onChange={(e) => patchItem(idx, { hsnSac: e.target.value })} placeholder="HSN/SAC" className={cellCls} />
                      <input type="number" min={1} value={it.quantity} onChange={(e) => patchItem(idx, { quantity: e.target.value })} placeholder="Qty" className={`${cellCls} text-right`} />
                      <input value={it.unit} onChange={(e) => patchItem(idx, { unit: e.target.value })} placeholder="Unit (e.g. No, Kg)" className={cellCls} />
                      <input type="number" min={0} step="0.01" value={it.rate} onChange={(e) => patchItem(idx, { rate: e.target.value })} placeholder="Rate" className={`${cellCls} text-right`} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-slate-500">
                        Amount: <span className="font-medium text-slate-800">{formatMoneyMinor(amt, currency)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setItems(items.length > 1 ? items.filter((_, i) => i !== idx) : items)}
                        disabled={items.length === 1}
                        className="inline-flex items-center gap-1 text-[12px] text-slate-400 hover:text-rose-600 disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                      </button>
                    </div>
                    {(errors[`items.${idx}.quantity`] || errors[`items.${idx}.rate`]) ? (
                      <span className="block text-[11px] text-rose-600">
                        {errors[`items.${idx}.quantity`] ?? errors[`items.${idx}.rate`]}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setItems([...items, { ...emptyItem }])}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
        </button>

        <div className="mt-4 ml-auto w-full max-w-xs space-y-1 text-[13px]">
          <Row label="Subtotal" value={formatMoneyMinor(totals.subtotalMinor, currency)} />
          <Row label={`GST @ ${Number(taxRate) || 0}%`} value={formatMoneyMinor(totals.taxMinor, currency)} />
          <Row label="Total" value={formatMoneyMinor(totals.totalMinor, currency)} bold />
        </div>
      </Section>

      <Section title="Terms & notes">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment terms"><input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="50% advance…" className={inputCls} /></Field>
          <Field label="Delivery terms"><input value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} placeholder="7–10 working days" className={inputCls} /></Field>
        </div>
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Any additional notes…" className={inputCls} /></Field>
      </Section>

      <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
        <button type="submit" disabled={pending} className="rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-indigo-500 disabled:opacity-60">
          {pending
            ? mode === 'edit'
              ? 'Saving…'
              : 'Creating…'
            : mode === 'edit'
              ? 'Save changes'
              : 'Create invoice'}
        </button>
      </div>
    </form>
  );
}

function ImageCell({
  item,
  onPick,
  onClear,
}: {
  item: ItemRow;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  if (item.imageUrl) {
    return (
      <div className="relative h-16 w-16 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.imageUrl} alt="" className="h-16 w-16 rounded-md border border-slate-200 object-cover" />
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove image"
          className="absolute -right-2 -top-2 rounded-full bg-white p-0.5 text-slate-500 shadow ring-1 ring-slate-200 hover:text-rose-600"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <label className="flex h-16 w-16 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-slate-300 text-[10px] text-slate-400 hover:border-indigo-400 hover:text-indigo-500">
      {item.__uploading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <>
          <ImagePlus className="h-4 w-4" aria-hidden />
          Image
        </>
      )}
      <input
        type="file"
        accept="image/*"
        className="hidden"
        disabled={item.__uploading}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
const cellCls =
  'w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] text-slate-900 outline-none focus:border-indigo-500';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-slate-600">{label}</span>
      {children}
      {error ? <span className="block text-[11px] text-rose-600">{error}</span> : null}
    </label>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? 'border-t border-slate-200 pt-1 font-semibold text-slate-900' : 'text-slate-600'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function PartyInputs({
  value,
  onChange,
  errors,
  prefix,
  namePlaceholder,
}: {
  value: PartyFields;
  onChange: (patch: Partial<PartyFields>) => void;
  errors: Record<string, string>;
  prefix: string;
  namePlaceholder: string;
}) {
  const cityListId = `${prefix}-cities`;
  const localityListId = `${prefix}-localities`;
  const cities = value.state ? citiesFor(value.state) : ALL_CITIES;
  const localities = localitiesFor(value.city);

  function onStateChange(name: string) {
    // GST state code is fixed per state — fill it automatically (kept for
    // the PDF, just not shown as a field).
    const patch: Partial<PartyFields> = {
      state: name,
      stateCode: stateCodeFor(name) ?? '',
    };
    // Drop a now-inconsistent city (and its locality/pin) when switching to
    // a different non-empty state.
    if (
      value.city &&
      name &&
      !citiesFor(name).some((c) => c.toLowerCase() === value.city.toLowerCase())
    ) {
      patch.city = '';
      patch.locality = '';
      patch.pincode = '';
    }
    onChange(patch);
  }
  function onCityChange(city: string) {
    const patch: Partial<PartyFields> = { city };
    // Locality + pin are city-specific — reset them when the city changes.
    if (city !== value.city) {
      patch.locality = '';
      patch.pincode = '';
    }
    // Keep state in sync with a known city.
    const st = uniqueStateForCity(city);
    if (st && st !== value.state) {
      patch.state = st;
      patch.stateCode = stateCodeFor(st) ?? '';
    }
    onChange(patch);
  }
  function onLocalityChange(locality: string) {
    const patch: Partial<PartyFields> = { locality };
    // Auto-fill the pin code for a known locality (still editable after).
    const pin = pincodeForLocality(value.city, locality);
    if (pin) patch.pincode = pin;
    onChange(patch);
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" error={errors[`${prefix}.name`]}>
          <input value={value.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={namePlaceholder} className={inputCls} />
        </Field>
        <Field label="GSTIN/UIN"><input value={value.gstin} onChange={(e) => onChange({ gstin: e.target.value })} placeholder="29ABCDE1234F1Z5" className={inputCls} /></Field>
      </div>
      <Field label="Address"><textarea value={value.address} onChange={(e) => onChange({ address: e.target.value })} rows={2} placeholder="Building / street" className={inputCls} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="State">
          <select value={value.state} onChange={(e) => onStateChange(e.target.value)} className={inputCls}>
            <option value="">Select state…</option>
            {INDIAN_STATES.map((s) => (
              <option key={s.code} value={s.name}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="City">
          <>
            <input list={cityListId} value={value.city} onChange={(e) => onCityChange(e.target.value)} placeholder="Start typing…" className={inputCls} />
            <datalist id={cityListId}>
              {cities.map((c) => <option key={c} value={c} />)}
            </datalist>
          </>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Locality / Area">
          <>
            <input list={localityListId} value={value.locality} onChange={(e) => onLocalityChange(e.target.value)} placeholder="e.g. Dwarka" className={inputCls} />
            <datalist id={localityListId}>
              {localities.map((l) => <option key={l.name} value={l.name} />)}
            </datalist>
          </>
        </Field>
        <Field label="Pin Code">
          <input value={value.pincode} onChange={(e) => onChange({ pincode: e.target.value })} maxLength={12} placeholder="110075" className={inputCls} />
        </Field>
      </div>
    </div>
  );
}
