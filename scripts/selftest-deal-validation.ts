/**
 * Unit self-test for the pure deal business rules — the Lead close-date rule
 * and the "margin required once a deal leaves Lead" rule, both as standalone
 * predicates and as enforced by the create/update form schemas. No DB.
 *   pnpm tsx scripts/selftest-deal-validation.ts
 */
import { createDealSchema, updateDealSchema } from '../src/lib/deals/schema';
import {
  marginRequiredForStage,
  violatesLeadCloseDate,
  violatesMissingMargin,
} from '../src/lib/deals/validation';

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

/* -------- margin required outside Lead -------- */

check('lead does not require a margin', marginRequiredForStage('lead') === false);
check('hold does not require a margin', marginRequiredForStage('hold') === false);
check('lost does not require a margin', marginRequiredForStage('lost') === false);
check('qualified requires a margin', marginRequiredForStage('qualified') === true);
check('proposal requires a margin', marginRequiredForStage('proposal') === true);
check('negotiation requires a margin', marginRequiredForStage('negotiation') === true);
check('won requires a margin', marginRequiredForStage('won') === true);

check('lead + no margin -> ok', violatesMissingMargin('lead', null) === false);
check('lead + margin -> ok', violatesMissingMargin('lead', 30) === false);
check('qualified + no margin -> violation', violatesMissingMargin('qualified', null) === true);
check('qualified + undefined margin -> violation', violatesMissingMargin('qualified', undefined) === true);
check('qualified + zero margin -> violation', violatesMissingMargin('qualified', 0) === true);
check('qualified + margin -> ok', violatesMissingMargin('qualified', 12.5) === false);
check('won + margin bps -> ok', violatesMissingMargin('won', 3000) === false);

/* -------- the same rule, through the form schemas -------- */

const baseForm = {
  name: 'Acme',
  description: null,
  amount: '50000',
  currency: 'INR',
  dealType: '',
  expectedCloseDate: null,
  companyId: null,
  contactId: null,
  ownerId: null,
};
const DEAL_ID = '00000000-0000-4000-8000-000000000000';

const leadNoMargin = createDealSchema.safeParse({
  ...baseForm,
  stage: 'lead',
  marginPct: '',
});
check('schema: lead with blank margin parses', leadNoMargin.success === true);
check(
  'schema: lead with blank margin yields undefined marginPct',
  leadNoMargin.success && leadNoMargin.data.marginPct === undefined,
);

const qualifiedNoMargin = createDealSchema.safeParse({
  ...baseForm,
  stage: 'qualified',
  marginPct: '',
  expectedCloseDate: '2026-09-30',
});
check('schema: qualified with blank margin is rejected', qualifiedNoMargin.success === false);
check(
  'schema: the rejection is reported on marginPct',
  !qualifiedNoMargin.success &&
    qualifiedNoMargin.error.issues.some((i) => i.path[0] === 'marginPct'),
);

const qualifiedWithMargin = createDealSchema.safeParse({
  ...baseForm,
  stage: 'qualified',
  marginPct: '30',
  expectedCloseDate: '2026-09-30',
});
check('schema: qualified with a margin parses', qualifiedWithMargin.success === true);
check(
  'schema: margin coerces to a number',
  qualifiedWithMargin.success && qualifiedWithMargin.data.marginPct === 30,
);
check(
  'schema: margin over 100 is still rejected in Lead',
  createDealSchema.safeParse({ ...baseForm, stage: 'lead', marginPct: '150' }).success === false,
);

check(
  'update schema: won with blank margin is rejected',
  updateDealSchema.safeParse({
    ...baseForm,
    id: DEAL_ID,
    stage: 'won',
    marginPct: '',
    expectedCloseDate: '2026-09-30',
  }).success === false,
);
check(
  'update schema: lead with blank margin parses',
  updateDealSchema.safeParse({
    ...baseForm,
    id: DEAL_ID,
    stage: 'lead',
    marginPct: '',
  }).success === true,
);


console.log('\n─── Deal validation unit self-test ───');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
process.exit(exitCode);
