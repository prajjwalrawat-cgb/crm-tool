/**
 * The rep quote editor's form model. Pure (no React, no DB): safe on the
 * client and covered by scripts/selftest-quote-editor.ts.
 *
 * Numeric inputs are kept as the text the rep typed, so partial input
 * ("12.") survives re-renders. They become integer minor units / basis
 * points only in `formToDraftInput`; unparseable text becomes NaN and the
 * draft schema (client preview or server save) reports it.
 */
import type { QuoteDraftInput } from './schema';
import type { QuoteContent, QuoteTemplateBody } from './template-schema';
import { computeQuoteTotals, type OverallDiscount, type QuoteTotals } from './totals';
import type { QuoteDetail, QuoteParty } from './types';

/** GST rates the line items select suggests (bps). Any 0..4000 is allowed via "Other". */
export const GST_SLABS_BPS = [0, 25, 300, 500, 1800, 4000] as const;

export function isGstSlab(bps: number): boolean {
  return (GST_SLABS_BPS as readonly number[]).includes(bps);
}

/** Exact decimal text with at most `dp` decimals -> integer scaled by 10^dp; NaN when invalid. */
function decimalToScaled(text: string, dp: number): number {
  const s = text.replace(/[,\s]/g, '');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2]) || (m[2] ?? '').length > dp) return NaN;
  const n = Number(m[1] || '0') * 10 ** dp + Number((m[2] ?? '').padEnd(dp, '0') || '0');
  return Number.isSafeInteger(n) ? n : NaN;
}

/** "1,000.50" -> 100050 paise. Empty, negative or more than 2 decimals -> NaN. */
export function rupeesToMinor(text: string): number {
  return decimalToScaled(text, 2);
}

/** 19000 -> "190", 100050 -> "1000.50" (input text, no grouping). */
export function minorToRupees(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

/** "18" -> 1800 bps, "2.5" -> 250. More than 2 decimals -> NaN. */
export function percentToBps(text: string): number {
  return decimalToScaled(text, 2);
}

/** 1800 -> "18", 250 -> "2.5". */
export function bpsToPercent(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

export type EditorParty = { [K in keyof QuoteParty]-?: string };

export type EditorItem = {
  /** Stable React key (the item id, or a client-generated one for new rows). */
  key: string;
  description: string;
  hsnSac: string;
  unit: string;
  quantity: string;
  /** Rupees. */
  rate: string;
  /** Percent. */
  discount: string;
  /** Percent. */
  taxRate: string;
  /** The GST select shows "Other" (free percent input) instead of a slab. */
  taxCustom: boolean;
  offeringId: string;
  groupLabel: string;
};

export type EditorDiscount = { type: OverallDiscount['type']; value: string };

export type QuoteEditorForm = {
  quoteDate: string;
  validUntil: string;
  sellerProfileId: string | null;
  buyer: EditorParty;
  consignee: EditorParty | null;
  items: EditorItem[];
  overallDiscount: EditorDiscount;
  content: QuoteContent;
};

export const EMPTY_PARTY: EditorParty = {
  name: '',
  address: '',
  city: '',
  locality: '',
  pincode: '',
  gstin: '',
  state: '',
  stateCode: '',
  contactName: '',
  contactEmail: '',
};

function toEditorParty(p: QuoteParty): EditorParty {
  const out = { ...EMPTY_PARTY };
  for (const k of Object.keys(EMPTY_PARTY) as (keyof EditorParty)[]) out[k] = p[k] ?? '';
  return out;
}

export function newEditorItem(key: string): EditorItem {
  return {
    key,
    description: '',
    hsnSac: '',
    unit: '',
    quantity: '1',
    rate: '',
    discount: '0',
    taxRate: '18',
    taxCustom: false,
    offeringId: '',
    groupLabel: '',
  };
}

export function formFromQuote(q: QuoteDetail): QuoteEditorForm {
  return {
    quoteDate: q.quoteDate,
    validUntil: q.validUntil,
    sellerProfileId: q.sellerProfileId,
    buyer: toEditorParty(q.buyer),
    consignee: q.consignee ? toEditorParty(q.consignee) : null,
    items: q.items.map((i) => ({
      key: i.id,
      description: i.description,
      hsnSac: i.hsnSac ?? '',
      unit: i.unit ?? '',
      quantity: String(Number(i.quantity)),
      rate: minorToRupees(i.rateMinor),
      discount: bpsToPercent(i.discountBps),
      taxRate: bpsToPercent(i.taxRateBps),
      taxCustom: !isGstSlab(i.taxRateBps),
      offeringId: i.offeringId ?? '',
      groupLabel: i.groupLabel ?? '',
    })),
    overallDiscount:
      q.overallDiscountType === 'amount'
        ? { type: 'amount', value: minorToRupees(q.overallDiscountValue) }
        : q.overallDiscountType === 'percent'
          ? { type: 'percent', value: bpsToPercent(q.overallDiscountValue) }
          : { type: 'none', value: '' },
    content: q.content,
  };
}

const opt = (s: string) => (s.trim() ? s.trim() : undefined);

function toParty(p: EditorParty): QuoteDraftInput['buyer'] {
  return {
    name: p.name.trim(),
    address: opt(p.address),
    city: opt(p.city),
    locality: opt(p.locality),
    pincode: opt(p.pincode),
    gstin: opt(p.gstin),
    state: opt(p.state),
    stateCode: opt(p.stateCode),
    contactName: opt(p.contactName),
    contactEmail: opt(p.contactEmail),
  };
}

function toQuantity(text: string): number {
  const s = text.replace(/[,\s]/g, '');
  return s && /^\d*\.?\d*$/.test(s) ? Number(s) : NaN;
}

export function toOverallDiscount(d: EditorDiscount): OverallDiscount {
  if (d.type === 'amount') return { type: 'amount', valueMinor: rupeesToMinor(d.value) };
  if (d.type === 'percent') return { type: 'percent', bps: percentToBps(d.value) };
  return { type: 'none' };
}

/** The payload for `updateQuoteDraftAction` (unparseable numbers are NaN; the schema flags them). */
export function formToDraftInput(f: QuoteEditorForm): QuoteDraftInput {
  return {
    quoteDate: f.quoteDate,
    validUntil: f.validUntil,
    sellerProfileId: f.sellerProfileId,
    buyer: toParty(f.buyer),
    consignee: f.consignee ? toParty(f.consignee) : null,
    items: f.items.map((i) => ({
      description: i.description.trim(),
      hsnSac: opt(i.hsnSac),
      unit: opt(i.unit),
      quantity: toQuantity(i.quantity),
      rateMinor: rupeesToMinor(i.rate),
      discountBps: percentToBps(i.discount),
      taxRateBps: percentToBps(i.taxRate),
      offeringId: opt(i.offeringId),
      groupLabel: opt(i.groupLabel),
    })),
    overallDiscount: toOverallDiscount(f.overallDiscount),
    content: f.content,
  };
}

/** Display-only totals for the form; null while any number is unparseable or out of range. */
export function formTotals(f: QuoteEditorForm): QuoteTotals | null {
  const d = formToDraftInput(f);
  try {
    return computeQuoteTotals(d.items, d.overallDiscount);
  } catch {
    return null;
  }
}

/**
 * The server quote with the form's edits applied and totals recomputed on
 * the client: what the live preview renders. null when the totals can't be
 * computed (the preview keeps its last render).
 */
export function previewQuote(base: QuoteDetail, f: QuoteEditorForm): QuoteDetail | null {
  const d = formToDraftInput(f);
  let totals: QuoteTotals;
  try {
    totals = computeQuoteTotals(d.items, d.overallDiscount);
  } catch {
    return null;
  }
  const od = d.overallDiscount;
  return {
    ...base,
    quoteDate: d.quoteDate,
    validUntil: d.validUntil,
    buyer: d.buyer,
    consignee: d.consignee,
    content: f.content,
    overallDiscountType: od.type,
    overallDiscountValue: od.type === 'amount' ? od.valueMinor : od.type === 'percent' ? od.bps : 0,
    subtotalMinor: totals.subtotalMinor,
    discountMinor: totals.discountMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
    items: d.items.map((it, i) => {
      const line = totals.lines[i]!;
      return {
        id: f.items[i]!.key,
        tenantId: base.tenantId,
        quoteId: base.id,
        sortOrder: i,
        description: it.description,
        hsnSac: it.hsnSac ?? null,
        unit: it.unit ?? null,
        quantity: it.quantity.toFixed(3),
        rateMinor: it.rateMinor,
        discountBps: it.discountBps,
        taxRateBps: it.taxRateBps,
        amountMinor: line.amountMinor,
        allocatedDiscountMinor: line.allocatedDiscountMinor,
        taxMinor: line.taxMinor,
        offeringId: it.offeringId ?? null,
        groupLabel: it.groupLabel ?? null,
        totals: line,
      };
    }),
    totals,
  };
}

/** Zod's NaN wording is meaningless to a rep. */
export function friendlyMessage(message: string): string {
  return /received NaN/i.test(message) ? 'Enter a number' : message;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

/** Deep equality of two template bodies, ignoring object key order (jsonb does not keep it). */
export function templateBodiesEqual(a: QuoteTemplateBody, b: QuoteTemplateBody): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** 191250 -> "₹1,912.50" (Indian grouping, as the PDF prints it). */
export function formatInr(minor: number): string {
  const s = (Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${minor < 0 ? '-' : ''}₹${s}`;
}
