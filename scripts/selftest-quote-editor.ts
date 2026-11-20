/**
 * Self-test for the rep quote editor's pure pieces: rupee/percent text <->
 * integer minor units / basis points, form <-> draft input mapping, the
 * client preview quote and the template-changed check.
 *   pnpm selftest:quote-editor
 */
import { defaultTemplateBody } from '../src/lib/quotes/default-template';
import {
  bpsToPercent,
  formatInr,
  formFromQuote,
  formToDraftInput,
  friendlyMessage,
  isGstSlab,
  minorToRupees,
  newEditorItem,
  percentToBps,
  previewQuote,
  rupeesToMinor,
  templateBodiesEqual,
  type QuoteEditorForm,
} from '../src/lib/quotes/editor-form';
import { quoteDraftInputSchema } from '../src/lib/quotes/schema';
import { defaultContentFor } from '../src/lib/quotes/template-schema';
import type { QuoteDetail } from '../src/lib/quotes/types';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}
const same = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

/* --------------------------- money / percent text -------------------------- */

const rupees: Array<[string, number]> = [
  ['500', 50_000],
  ['1,000.5', 100_050],
  [' 190 ', 19_000],
  ['0.05', 5],
  ['12.', 1_200],
  ['.5', 50],
  ['0', 0],
];
for (const [text, want] of rupees) check(`rupeesToMinor(${JSON.stringify(text)}) = ${want}`, rupeesToMinor(text) === want, String(rupeesToMinor(text)));
for (const bad of ['', '1.234', '-5', 'abc', '1e3', '1.2.3', '99999999999999999']) {
  check(`rupeesToMinor(${JSON.stringify(bad)}) is NaN`, Number.isNaN(rupeesToMinor(bad)), String(rupeesToMinor(bad)));
}
check('minorToRupees: whole rupees drop the decimals', minorToRupees(19_000) === '190');
check('minorToRupees: paise keep two decimals', minorToRupees(100_050) === '1000.50' && minorToRupees(5) === '0.05');
check('rupees round-trip', [0, 1, 99, 100, 123_456, 191_250].every((m) => rupeesToMinor(minorToRupees(m)) === m));

check('percentToBps: 18 -> 1800, 2.5 -> 250, 0.25 -> 25', percentToBps('18') === 1800 && percentToBps('2.5') === 250 && percentToBps('0.25') === 25);
check('percentToBps: >2dp / empty / text -> NaN', [percentToBps('1.234'), percentToBps(''), percentToBps('x')].every(Number.isNaN));
check('bpsToPercent: 1800 -> "18", 250 -> "2.5", 25 -> "0.25"', bpsToPercent(1800) === '18' && bpsToPercent(250) === '2.5' && bpsToPercent(25) === '0.25');
check('formatInr: Indian grouping', formatInr(191_250) === '₹1,912.50' && formatInr(12_345_678_900) === '₹12,34,56,789.00' && formatInr(-5) === '-₹0.05', formatInr(12_345_678_900));
check('GST slabs: 0, 0.25, 3, 5, 18, 40 %', [0, 25, 300, 500, 1800, 4000].every(isGstSlab) && !isGstSlab(1200));

/* ------------------------------ quote fixture ------------------------------ */

const body = defaultTemplateBody();
const quote: QuoteDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  dealId: '00000000-0000-4000-8000-000000000003',
  quoteNumber: 'Q/2026-27/0001',
  revision: 1,
  parentQuoteId: null,
  status: 'draft',
  templateId: null,
  templateSnapshot: body,
  content: defaultContentFor(body),
  sellerProfileId: null,
  seller: { name: 'Seller Pvt Ltd', gstin: '29ABCDE1234F1Z5' },
  buyer: { name: 'Acme', contactName: 'Asha', stateCode: '27', state: 'Maharashtra' },
  consignee: null,
  quoteDate: '2026-11-20',
  validUntil: '2026-12-20',
  currency: 'INR',
  overallDiscountType: 'percent',
  overallDiscountValue: 250,
  subtotalMinor: 0,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 0,
  sentAt: null,
  sentBy: null,
  pdfDocumentId: null,
  createdBy: 'user_1',
  updatedBy: 'user_1',
  createdAt: new Date('2026-11-20T00:00:00Z'),
  updatedAt: new Date('2026-11-20T00:00:00Z'),
  items: [
    {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenantId: '00000000-0000-4000-8000-000000000002',
      quoteId: '00000000-0000-4000-8000-000000000001',
      sortOrder: 0,
      description: 'Widget',
      hsnSac: '8471',
      unit: null,
      quantity: '1.500',
      rateMinor: 100_050,
      discountBps: 1000,
      taxRateBps: 1200,
      amountMinor: 0,
      allocatedDiscountMinor: 0,
      taxMinor: 0,
      offeringId: null,
      groupLabel: null,
      totals: { grossMinor: 0, lineDiscountMinor: 0, amountMinor: 0, allocatedDiscountMinor: 0, taxableMinor: 0, taxMinor: 0 },
    },
  ],
  totals: { lines: [], subtotalMinor: 0, lineDiscountMinor: 0, overallDiscountMinor: 0, discountMinor: 0, taxableMinor: 0, taxGroups: [], taxMinor: 0, totalMinor: 0 },
};

/* ------------------------------- form mapping ------------------------------ */

const form = formFromQuote(quote);
const item = form.items[0]!;
check('formFromQuote: quantity "1.500" -> "1.5"', item.quantity === '1.5', item.quantity);
check('formFromQuote: rate in rupees, discount and GST in percent', item.rate === '1000.50' && item.discount === '10' && item.taxRate === '12');
check('formFromQuote: a non-slab GST rate opens "Other"', item.taxCustom === true);
check('formFromQuote: percent overall discount', same(form.overallDiscount, { type: 'percent', value: '2.5' }));
check('formFromQuote: missing party fields become ""', form.buyer.address === '' && form.buyer.stateCode === '27');

const roundTrip = formToDraftInput(form);
check('form -> draft round-trips the stored values', same(roundTrip.items[0], {
  description: 'Widget', hsnSac: '8471', unit: undefined, quantity: 1.5, rateMinor: 100_050, discountBps: 1000, taxRateBps: 1200, offeringId: undefined, groupLabel: undefined,
}), JSON.stringify(roundTrip.items[0]));
check('form -> draft: overall discount back to bps', same(roundTrip.overallDiscount, { type: 'percent', bps: 250 }));
check('form -> draft: blank optional party fields are dropped', roundTrip.buyer.address === undefined && roundTrip.buyer.name === 'Acme');
check('form -> draft passes the server schema', quoteDraftInputSchema.safeParse(roundTrip).success);

// The plan's Step 3 example: Task 2 A/B lines, overall discount of ₹190.
const ab: QuoteEditorForm = {
  ...form,
  items: [
    { ...newEditorItem('a'), description: 'Line A', quantity: '2', rate: '500', discount: '0', taxRate: '18' },
    { ...newEditorItem('b'), description: 'Line B', quantity: '1', rate: '1,000', discount: '10', taxRate: '5' },
  ],
  overallDiscount: { type: 'amount', value: '190' },
};
const abDraft = formToDraftInput(ab);
check('A/B: draft lines in minor units / bps', same(abDraft.items.map((i) => [i.quantity, i.rateMinor, i.discountBps, i.taxRateBps]), [[2, 50_000, 0, 1800], [1, 100_000, 1000, 500]]));
check('A/B: ₹190 -> { amount, 19000 }', same(abDraft.overallDiscount, { type: 'amount', valueMinor: 19_000 }));
const preview = previewQuote(quote, ab);
check('A/B preview: total ₹1,912.50 (191250)', preview?.totals.totalMinor === 191_250, String(preview?.totals.totalMinor));
check('A/B preview: taxable ₹1,710 (deal value)', preview?.totals.taxableMinor === 171_000);
check('A/B preview: header totals and items carry the computed figures', preview?.totalMinor === 191_250 && preview.items.length === 2 && preview.items[1]!.allocatedDiscountMinor === 9000 && preview.items[0]!.quantity === '2.000');
check('A/B preview: keeps id / number / snapshot from the server quote', preview?.id === quote.id && preview.quoteNumber === quote.quoteNumber && preview.templateSnapshot === quote.templateSnapshot);

const newItem = newEditorItem('k');
check('new item: qty 1, GST 18%, no discount', newItem.quantity === '1' && newItem.taxRate === '18' && newItem.discount === '0' && !newItem.taxCustom);

check('preview: an unparseable rate gives null (keep the last render)', previewQuote(quote, { ...ab, items: [{ ...ab.items[0]!, rate: 'abc' }] }) === null);
check('preview: discount above the subtotal gives null', previewQuote(quote, { ...ab, overallDiscount: { type: 'amount', value: '999999' } }) === null);
check('preview: no items is still a valid preview', previewQuote(quote, { ...ab, items: [], overallDiscount: { type: 'none', value: '' } })?.totals.totalMinor === 0);

const nanDraft = formToDraftInput({ ...ab, items: [{ ...ab.items[0]!, rate: '' }] });
const nanParse = quoteDraftInputSchema.safeParse(nanDraft);
const rateIssue = nanParse.success ? undefined : nanParse.error.issues.find((i) => i.path.join('.') === 'items.0.rateMinor');
check('blank rate fails the schema on items.0.rateMinor', rateIssue !== undefined);
check('friendlyMessage: NaN number errors read "Enter a number"', friendlyMessage(rateIssue?.message ?? '') === 'Enter a number', rateIssue?.message);
check('friendlyMessage: other messages unchanged', friendlyMessage('Description is required') === 'Description is required');

/* ---------------------------- template changed ----------------------------- */

const reordered = JSON.parse(JSON.stringify(body, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
check('templateBodiesEqual: ignores object key order', templateBodiesEqual(body, reordered));
const edited = defaultTemplateBody();
edited.theme.primaryColor = '#000000';
check('templateBodiesEqual: a changed setting differs', !templateBodiesEqual(body, edited));
const moved = defaultTemplateBody();
moved.sections.reverse();
check('templateBodiesEqual: section order matters', !templateBodiesEqual(body, moved));

/* --------------------------------- report ---------------------------------- */

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(exitCode);
