/**
 * Self-test for the Won rule's arithmetic (0071): when do a deal's order
 * proofs (client POs) match its value? Pure — no database, no AI. The
 * `deal_order_proof_check` trigger encodes the same rule; keep them in step.
 *
 *   npx tsx scripts/selftest-order-proofs.ts
 */
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

process.exit(exitCode);
