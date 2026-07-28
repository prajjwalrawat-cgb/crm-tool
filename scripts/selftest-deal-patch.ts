import {
  buildDealColumnPatch,
  UnitPricingIncompleteError,
  type PreviousDealValues,
} from '../src/lib/deals/patch-columns';
import { patchDealSchema } from '../src/lib/deals/schema';

/**
 * Pure self-test for the partial deal update. Guards the regression where a
 * one-field editor saved through the full-form action and blanked every column
 * it didn't submit — unit price, quantity, description, deal type, owner and
 * custom fields. The invariant: a column is written ONLY when its field was
 * present in the input.
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const ID = '00000000-0000-4000-8000-000000000001';
const previous: PreviousDealValues = {
  currency: 'INR',
  unitPriceMinor: 9000,
  quantity: 100,
};

function parse(input: Record<string, unknown>) {
  const r = patchDealSchema.safeParse({ id: ID, ...input });
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
}

// 1. A rename writes the name and nothing else — the columns that used to get
//    nulled must be absent entirely.
const renamed = buildDealColumnPatch(parse({ name: 'Renamed' }), previous);
check(
  'rename writes only the name column',
  JSON.stringify(Object.keys(renamed)) === JSON.stringify(['name']),
  Object.keys(renamed).join(','),
);
for (const col of [
  'unitPriceMinor',
  'quantity',
  'amountMinor',
  'dealType',
  'ownerId',
  'marginBps',
  'expectedCloseDate',
]) {
  check(`rename leaves ${col} untouched`, !(col in renamed));
}

// 2. Editing the margin touches only marginBps (20% → 2000bps).
const margin = buildDealColumnPatch(parse({ marginPct: '20' }), previous);
check(
  'margin patch writes only marginBps',
  JSON.stringify(Object.keys(margin)) === JSON.stringify(['marginBps']) &&
    margin.marginBps === 2000,
  `${Object.keys(margin).join(',')}=${String(margin.marginBps)}`,
);

// 3. Patching one side of unit pricing fills the other from the stored row and
//    re-derives the amount.
const qtyOnly = buildDealColumnPatch(parse({ quantity: '250' }), previous);
check(
  'quantity patch keeps the stored unit price',
  qtyOnly.unitPriceMinor === 9000 && qtyOnly.quantity === 250,
  `${String(qtyOnly.unitPriceMinor)} x ${String(qtyOnly.quantity)}`,
);
check(
  'quantity patch re-derives the amount',
  qtyOnly.amountMinor === 9000 * 250,
  String(qtyOnly.amountMinor),
);

const priceOnly = buildDealColumnPatch(parse({ unitPrice: '120.50' }), previous);
check(
  'unit price patch converts to minor units',
  priceOnly.unitPriceMinor === 12050,
  String(priceOnly.unitPriceMinor),
);
check(
  'unit price patch re-derives the amount',
  priceOnly.amountMinor === 12050 * 100,
  String(priceOnly.amountMinor),
);

// 4. Unit pricing on a deal that has none is refused rather than half-written.
let threw = false;
try {
  buildDealColumnPatch(parse({ quantity: '5' }), {
    currency: 'INR',
    unitPriceMinor: null,
    quantity: null,
  });
} catch (e) {
  threw = e instanceof UnitPricingIncompleteError;
}
check('incomplete unit pricing is refused', threw);

// 5. Explicit nulls ARE written — clearing a field is a real edit.
const cleared = buildDealColumnPatch(
  parse({ expectedCloseDate: null, dealType: null }),
  previous,
);
check(
  'explicit null clears the close date',
  'expectedCloseDate' in cleared && cleared.expectedCloseDate === null,
);
check(
  'explicit null clears the deal type',
  'dealType' in cleared && cleared.dealType === null,
);

// 6. An id-only patch writes nothing at all.
const empty = buildDealColumnPatch(parse({}), previous);
check('id-only patch writes no columns', Object.keys(empty).length === 0);

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
process.exit(exitCode);
