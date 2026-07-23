/**
 * Unit self-test for the Lead-close-date business rule (pure). No DB.
 *   pnpm tsx scripts/selftest-deal-validation.ts
 */
import { violatesLeadCloseDate } from '../src/lib/deals/validation';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  results.push({ name, ok });
  if (!ok) exitCode = 1;
}

check('lead + close date → violation', violatesLeadCloseDate('lead', '2026-08-01') === true);
check('lead + no close date → ok', violatesLeadCloseDate('lead', null) === false);
check('lead + empty close date → ok', violatesLeadCloseDate('lead', '  ') === false);
check('qualified + close date → ok', violatesLeadCloseDate('qualified', '2026-08-01') === false);
check('negotiation + close date → ok', violatesLeadCloseDate('negotiation', '2026-08-01') === false);

console.log('\n─── Deal validation unit self-test ───');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
process.exit(exitCode);
