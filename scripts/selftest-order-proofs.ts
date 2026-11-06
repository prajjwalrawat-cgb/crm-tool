/**
 * Self-test for order proofs (0071). Pure — no database, no PDF files:
 *   1. the Won rule's arithmetic — when do a deal's proofs match its value?
 *      The `deal_order_proof_check` trigger encodes the same rule; keep them
 *      in step;
 *   2. reading a PO by its labels, over the layouts clients actually send.
 *
 *   npx tsx scripts/selftest-order-proofs.ts
 */
import {
  proofWarnings,
  sameCompany,
  type ProofCheckContext,
  type ProofUnderCheck,
} from '../src/lib/order-proofs/checks';
import { dateIn, parseOrderText, type TextLine } from '../src/lib/order-proofs/parse';
import {
  matchOrderProofs,
  ORDER_PROOF_ROUNDING_MINOR,
  orderProofProblem,
} from '../src/lib/order-proofs/shared';

let exitCode = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) exitCode = 1;
}

const deal = { amountMinor: 10_00_000_00, currency: 'INR' }; // ₹10,00,000.00
const po = (subtotalMinor: number, currency = 'INR') => ({ subtotalMinor, currency });

let m = matchOrderProofs(deal, []);
check('no proof → none', m.state === 'none', m);
check('no proof → a problem to fix', orderProofProblem(deal, m)?.includes('Attach') === true);

m = matchOrderProofs(deal, [po(10_00_000_00)]);
check('exact PO → match', m.state === 'match', m);
check('match → no problem', orderProofProblem(deal, m) === null);

m = matchOrderProofs(deal, [po(10_00_000_00 + ORDER_PROOF_ROUNDING_MINOR)]);
check('within ₹1 rounding → match', m.state === 'match', m);

m = matchOrderProofs(deal, [po(10_00_000_00 + ORDER_PROOF_ROUNDING_MINOR + 1)]);
check('one paisa beyond rounding → gap', m.state === 'gap', m);

m = matchOrderProofs(deal, [po(9_50_000_00)]);
check('PO below deal value → gap', m.state === 'gap' && m.gapMinor === -50_000_00, m);
check('…says the deal is MORE than the PO', /more than the PO/.test(orderProofProblem(deal, m) ?? ''));

m = matchOrderProofs(deal, [po(11_80_000_00)]);
check('PO above deal value (e.g. GST-inclusive typed as deal) → gap', m.state === 'gap' && m.gapMinor === 1_80_000_00, m);
check('…says the deal is LESS than the PO', /less than the PO/.test(orderProofProblem(deal, m) ?? ''));

m = matchOrderProofs(deal, [po(6_00_000_00), po(4_00_000_00)]);
check('two POs adding up → match', m.state === 'match' && m.proofMinor === 10_00_000_00, m);

m = matchOrderProofs(deal, [po(10_00_000_00, 'USD')]);
check('PO in another currency → currency', m.state === 'currency', m);
check('…names both currencies', /USD.*INR/.test(orderProofProblem(deal, m) ?? ''));

m = matchOrderProofs(deal, [po(10_00_000_00), po(1, 'USD')]);
check('any proof in another currency blocks, even if INR adds up', m.state === 'currency', m);

check('rounding matches the trigger (100 minor units)', ORDER_PROOF_ROUNDING_MINOR === 100);

/* ── Reading by labels ───────────────────────────────────── */

// A page as the reader lays it out: each line a list of [x, text] columns.
const page = (...rows: Array<Array<[number, string]>>): TextLine[] =>
  rows.map((r) => ({ segments: r.map(([x, text]) => ({ x, text })) }));

// Tally-style: IGST only, amounts with ₹ and /-, "Dated" label, month name.
let read = parseOrderText(
  page(
    [[40, 'Sharma Agro Exports Private Limited']],
    [[40, 'PURCHASE ORDER']],
    [[40, 'P.O. No. : SAE/24-25/112'], [360, 'Dated : 5 Nov 2026']],
    [[40, 'Delivery date: 30/11/2026']],
    [[40, 'Taxable Value'], [480, '₹ 2,50,000.00']],
    [[40, 'IGST @ 18%'], [480, '45,000.00']],
    [[40, 'Total Amount Payable'], [480, '₹ 2,95,000/-']],
  ),
);
check('IGST PO: number', read.referenceNo === 'SAE/24-25/112', read);
check('IGST PO: "5 Nov 2026", not the delivery date', read.issuedOn === '2026-11-05', read);
check('IGST PO: buyer from the letterhead', read.buyerName === 'Sharma Agro Exports Private Limited', read);
check('IGST PO: taxable value, IGST, total payable', read.subtotal === 250000 && read.tax === 45000 && read.total === 295000, read);
check('IGST PO: INR', read.currency === 'INR', read);
check('IGST PO: high confidence', read.confidence === 'high', read);

// SAP-style: a plain "Total" row above the taxes is the value before tax.
read = parseOrderText(
  page(
    [[40, 'Purchase Order Number'], [200, '4500012345']],
    [[40, 'Document Date'], [200, '2026-10-28']],
    [[40, 'Bill To:']],
    [[40, 'Kaveri Steel Works Ltd.']],
    [[40, '1'], [80, 'Gear box assembly'], [400, '10'], [480, '12,000.00']],
    [[40, 'Total'], [480, '1,20,000.00']],
    [[40, 'CGST 9%'], [480, '10,800.00']],
    [[40, 'SGST 9%'], [480, '10,800.00']],
    [[40, 'Grand Total INR'], [480, '1,41,600.00']],
  ),
);
check('SAP PO: number beside its label', read.referenceNo === '4500012345', read);
check('SAP PO: ISO date', read.issuedOn === '2026-10-28', read);
check('SAP PO: buyer under "Bill To"', read.buyerName === 'Kaveri Steel Works Ltd.', read);
check('SAP PO: plain Total above taxes is the value before tax', read.subtotal === 120000, read);
check('SAP PO: CGST + SGST added up', read.tax === 21600 && read.total === 141600, read);

// Only a grand total and a GST line: value before tax is worked out.
read = parseOrderText(
  page(
    [[40, 'PO #: 7781']],
    [[40, 'GSTIN: 29ABCDE1234F1Z5']],
    [[40, 'GST (18%)'], [480, '9,000.00']],
    [[40, 'Grand Total'], [480, '59,000.00']],
  ),
);
check('derived: value before tax = total − tax', read.subtotal === 50000 && read.tax === 9000, read);
check('derived: says so in the notes', /worked out/.test(read.notes ?? ''), read);
check('derived: the GSTIN is not read as tax', read.tax === 9000, read);

// A quotation is flagged, not trusted.
read = parseOrderText(
  page(
    [[40, 'QUOTATION']],
    [[40, 'Quote Ref: Q-2026-88']],
    [[40, 'Sub Total'], [480, '75,000.00']],
  ),
);
check('quotation: low confidence', read.confidence === 'low', read);
check('quotation: flagged in the notes', /quotation/i.test(read.notes ?? ''), read);

// Figures that don't add up are reported, not silently accepted.
read = parseOrderText(
  page(
    [[40, 'PO No: 55']],
    [[40, 'Sub-total'], [480, '1,00,000.00']],
    [[40, 'GST'], [480, '18,000.00']],
    [[40, 'Grand total'], [480, '1,20,000.00']],
  ),
);
check('mismatched totals: noted', /does not equal/.test(read.notes ?? ''), read);
check('mismatched totals: not high confidence', read.confidence !== 'high', read);

check('date: 03-11-2026 is 3 Nov (day first)', dateIn('03-11-2026') === '2026-11-03');
check('date: 05/23/2026 can only be US order', dateIn('05/23/2026') === '2026-05-23');
check('date: "Nov 3, 2026"', dateIn('Nov 3, 2026') === '2026-11-03');
check('date: 31/02/2026 is not a date', dateIn('31/02/2026') === null);

// Who the PO is addressed to, and the GSTINs on it.
read = parseOrderText(
  page(
    [[40, 'Kaveri Steel Works Ltd.'], [360, 'GSTIN: 29ABCDE1234F1Z5']],
    [[40, 'PURCHASE ORDER No: KSW/77']],
    [[40, 'To,']],
    [[40, 'M/s CGB Solutions Pvt Ltd'], [360, 'GSTIN: 07AAACC1234D1Z9']],
    [[40, 'Sub Total'], [480, '10,000.00']],
  ),
);
check('supplier under "To," with M/s stripped', read.supplierName === 'CGB Solutions Pvt Ltd', read);
check('buyer is the letterhead, not the supplier', read.buyerName === 'Kaveri Steel Works Ltd.', read);
check('both GSTINs found', read.gstins?.length === 2 && read.gstins.includes('07AAACC1234D1Z9'), read);
check('kind: order', read.kind === 'order', read);

/* ── Checks beyond the amount ────────────────────────────── */

const ctx: ProofCheckContext = {
  dealCompany: 'Kaveri Steel Works Private Limited',
  dealCreatedOn: '2026-10-01',
  sellerNames: ['CGB Solutions'],
  sellerGstins: ['07AAACC1234D1Z9'],
};
const today = '2026-11-05';
const proof: ProofUnderCheck = {
  buyerName: 'KAVERI STEEL WORKS LTD',
  issuedOn: '2026-11-03',
  subtotalMinor: 1_000_000,
  taxMinor: 180_000,
  totalMinor: 1_180_000,
  read,
};
const codes = (p: Partial<typeof proof>, c: Partial<ProofCheckContext> = {}) =>
  proofWarnings({ ...proof, ...p }, { ...ctx, ...c }, today).map((w) => w.code);

check('clean PO: no warnings', codes({}).length === 0, codes({}));
check('names: legal suffixes and case ignored', sameCompany('Acme Test Industries Pvt. Ltd.', 'ACME TEST INDUSTRIES PRIVATE LIMITED'));
check('names: different companies differ', !sameCompany('Acme Test Industries', 'Kaveri Steel Works'));
check('buyer from another company', codes({ buyerName: 'Acme Test Industries' }).includes('buyer_mismatch'));
check('buyer left empty', codes({ buyerName: null }).includes('buyer_missing'));
check('deal with no company: buyer not checked', codes({ buyerName: null }, { dealCompany: null }).length === 0);
check('addressed to another vendor (name)', codes({ read: { ...read, supplierName: 'Globex Systems', gstins: [] } }).includes('supplier_mismatch'));
check(
  'addressed to another vendor (GSTINs, none ours)',
  codes({ read: { ...read, supplierName: null, gstins: ['29ABCDE1234F1Z5', '27ZZZZZ9999Z1Z1'] } }).includes('supplier_mismatch'),
);
check('our GSTIN on it: supplier fine', !codes({ read: { ...read, supplierName: 'Someone Else' } }).includes('supplier_mismatch'));
check('typed-in photo: supplier not checked', !codes({ read: null }).includes('supplier_mismatch'));
check('no date', codes({ issuedOn: null }).includes('date_missing'));
check('future date', codes({ issuedOn: '2026-12-01' }).includes('date_future'));
check('older than 6 months', codes({ issuedOn: '2026-03-01' }).includes('date_stale'));
check('older than the deal', codes({ issuedOn: '2026-09-15' }).includes('date_before_deal'));
check('quotation', codes({ read: { ...read, kind: 'other' } }).includes('not_an_order'));
check('figures don\'t add up', codes({ totalMinor: 1_300_000 }).includes('totals_mismatch'));
check('total left blank: not a mismatch', !codes({ totalMinor: null }).includes('totals_mismatch'));

const severityOf = (p: Partial<ProofUnderCheck>, code: string) =>
  proofWarnings({ ...proof, ...p }, ctx, today).find((w) => w.code === code)?.severity;
check('date missing blocks', severityOf({ issuedOn: null }, 'date_missing') === 'block');
check('future date blocks', severityOf({ issuedOn: '2026-12-01' }, 'date_future') === 'block');
check('stale date blocks', severityOf({ issuedOn: '2026-03-01' }, 'date_stale') === 'block');
check('date before the deal blocks', severityOf({ issuedOn: '2026-09-15' }, 'date_before_deal') === 'block');
check('other buyer only warns', severityOf({ buyerName: 'Acme Test Industries' }, 'buyer_mismatch') === 'warn');
check('figures only warn', severityOf({ totalMinor: 1_300_000 }, 'totals_mismatch') === 'warn');
check('a PO dated today passes', codes({ issuedOn: today }).length === 0, codes({ issuedOn: today }));

process.exit(exitCode);
