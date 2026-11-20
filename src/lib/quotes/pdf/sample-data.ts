/**
 * Fake quote used by the template builder's live preview (and the PDF
 * self-test). Pure: no DB, safe on the client.
 */
import { defaultContentFor, type QuoteTemplateBody } from '../template-schema';
import { computeQuoteTotals, type QuoteLineInput } from '../totals';
import type { QuoteDetail, QuoteDetailItem } from '../types';
import type { QuoteRenderInput } from './context';
import { buildPlaceholderValues } from './quote-document';

type SampleLine = QuoteLineInput & { description: string; hsnSac: string; unit: string; groupLabel: string | null };

const BASE_LINES: SampleLine[] = [
  { description: 'Annual software licence (25 users)', hsnSac: '997331', unit: 'Nos', quantity: 25, rateMinor: 1_200_000, discountBps: 1000, taxRateBps: 1800, groupLabel: 'Software' },
  { description: 'Implementation and data migration', hsnSac: '998313', unit: 'Job', quantity: 1, rateMinor: 15_000_000, discountBps: 0, taxRateBps: 1800, groupLabel: 'Services' },
  { description: 'On-site training', hsnSac: '999293', unit: 'Day', quantity: 2, rateMinor: 2_500_000, discountBps: 0, taxRateBps: 500, groupLabel: 'Services' },
];

function sampleLines(count: number | undefined): SampleLine[] {
  if (count === undefined) return BASE_LINES;
  return Array.from({ length: count }, (_, i) => ({
    ...BASE_LINES[i % BASE_LINES.length],
    description: `Sample item ${i + 1}`,
  }));
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type SampleOptions = {
  /** Replace the three sample lines with `itemCount` generated lines ("Sample item N"). */
  itemCount?: number;
  /** Buyer in a different state from the seller (IGST instead of CGST + SGST). */
  interState?: boolean;
};

export function sampleRenderInput(body: QuoteTemplateBody, opts: SampleOptions = {}): QuoteRenderInput {
  const lines = sampleLines(opts.itemCount);
  const totals = computeQuoteTotals(lines, { type: 'none' });
  const id = '00000000-0000-4000-8000-000000000001';
  const tenantId = '00000000-0000-4000-8000-000000000000';
  const today = new Date();
  const valid = new Date(today);
  valid.setDate(valid.getDate() + 30);

  const items: QuoteDetailItem[] = lines.map((l, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
    tenantId,
    quoteId: id,
    sortOrder: i,
    description: l.description,
    hsnSac: l.hsnSac,
    unit: l.unit,
    quantity: String(l.quantity),
    rateMinor: l.rateMinor,
    discountBps: l.discountBps,
    taxRateBps: l.taxRateBps,
    amountMinor: totals.lines[i].amountMinor,
    allocatedDiscountMinor: totals.lines[i].allocatedDiscountMinor,
    taxMinor: totals.lines[i].taxMinor,
    offeringId: null,
    groupLabel: l.groupLabel,
    totals: totals.lines[i],
  }));

  const quote: QuoteDetail = {
    id,
    tenantId,
    dealId: '00000000-0000-4000-8000-000000000002',
    quoteNumber: 'Q/2026-27/0042',
    revision: 1,
    parentQuoteId: null,
    status: 'draft',
    templateId: null,
    templateSnapshot: body,
    content: defaultContentFor(body),
    sellerProfileId: null,
    seller: {
      name: 'Acme Software Pvt Ltd',
      address: '4th Floor, 12 MG Road',
      city: 'Bengaluru',
      pincode: '560001',
      state: 'Karnataka',
      stateCode: '29',
      gstin: '29AABCA1234F1Z5',
      pan: 'AABCA1234F',
    },
    buyer: opts.interState
      ? { name: 'Globex Industries Ltd', contactName: 'Priya Sharma', contactEmail: 'priya@globex.example', address: '22 Nariman Point', city: 'Mumbai', pincode: '400021', state: 'Maharashtra', stateCode: '27', gstin: '27AAACG5678K1Z2' }
      : { name: 'Globex Industries Ltd', contactName: 'Priya Sharma', contactEmail: 'priya@globex.example', address: '8 Residency Road', city: 'Bengaluru', pincode: '560025', state: 'Karnataka', stateCode: '29', gstin: '29AAACG5678K1Z2' },
    consignee: null,
    quoteDate: isoDate(today),
    validUntil: isoDate(valid),
    currency: 'INR',
    overallDiscountType: 'none',
    overallDiscountValue: 0,
    subtotalMinor: totals.subtotalMinor,
    discountMinor: totals.discountMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
    sentAt: null,
    sentBy: null,
    pdfDocumentId: null,
    createdBy: null,
    updatedBy: null,
    createdAt: today,
    updatedAt: today,
    items,
    totals,
  };

  const dealCustomFields: Record<string, unknown> = {};
  for (const s of body.sections) {
    if (s.type === 'custom_fields') for (const f of s.settings.fields) dealCustomFields[f.key] = `Sample ${f.label || f.key}`;
  }

  return {
    body,
    quote,
    logoUrl: null,
    placeholderValues: { ...buildPlaceholderValues(quote, { name: 'Rahul Verma', email: 'rahul@acme.example' }), 'deal.name': 'CRM rollout 2026' },
    dealCustomFields,
  };
}
