/**
 * Self-test for the Offerings taxonomy (0066).
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-offerings.ts
 *
 * What is worth testing here, and why each one rather than a click-through:
 *
 *   1. THE MANDATORY RULE IS CREATE-ONLY. Two assertions that pull in
 *      opposite directions and are easy to break together: a new deal
 *      cannot be saved untagged, and an EXISTING untagged deal must stay
 *      fully editable. A regression that "tightened" the rule to all
 *      writes would block the first person to touch any legacy deal, and
 *      would look like a fix in review.
 *
 *   2. PRIMARY IS DERIVED, NOT REMEMBERED. The picker holds a primary
 *      choice; unticking that offering must not leave a primary pointing
 *      at a row nobody is inserting. One tag auto-defaults to primary;
 *      two with no choice is an error, not a coin flip.
 *
 *   3. EXACTLY ONE PRIMARY, ENFORCED BY THE DATABASE. The app clears the
 *      old primary first, but a second `true` must be impossible even if
 *      a future write path forgets — a second primary is silent
 *      corruption, since the list column would pick one per query plan.
 *
 *   4. A BUNDLE COUNTS IN BOTH FUNNELS, AT FULL VALUE. This is the whole
 *      reason the join table exists, and the property most likely to be
 *      "fixed" into a primary-only join by someone who sees the rollup
 *      rows summing to more than total pipeline.
 *
 *   5. TAGGED + UNCATEGORIZED = ALL DEALS. The coverage arithmetic on the
 *      report, and the deals-list filter that backs it. If these two
 *      predicates ever stop being exact complements, a deal falls into
 *      neither and silently disappears from the coverage story.
 *
 *   6. RETIRING IS NOT DELETING. A deactivated offering vanishes from the
 *      picker, keeps rendering on the deals that carry it, and keeps its
 *      funnel numbers. The FK must also refuse a hard delete outright.
 *
 *   8. THE WORKSPACE SWITCH MEANS INVISIBLE AND INERT (0067). OFF by
 *      default for a new workspace; OFF strips the offering filters so a
 *      stale bookmark can't narrow a list invisibly; OFF makes the funnel
 *      report not exist; and OFF deletes nothing - tags survive a round
 *      trip. The create/update actions need an authenticated session a
 *      script can't provide, so their gating is guarded at the source
 *      level: the one regression that matters (a hidden drawer submitting
 *      an empty selection into the tag sync, refusing every save of a
 *      previously-tagged deal) is a missing `if (offeringsEnabled)`.
 *
 *   7. THE ROLLUP EQUALS A HAND SUM. Computed against a fixture with
 *      known answers rather than against whatever the database holds — a
 *      rollup that is wrong in the same way as the query checking it
 *      passes every test that shares its SQL.
 *
 * 1 (the pure half) and 2 are pure and always run. The rest need a
 * database and are SKIPPED, not failed, without one — matching the other
 * selftests. The database checks build their own tenant and drop it
 * afterwards, so the run is deterministic and leaves nothing behind.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

import {
  compareOfferings,
  defaultPrimary,
  groupByCategory,
  offeringRuleFor,
  OFFERING_CATEGORIES,
  primaryOfferingOf,
  validateOfferingSelection,
} from '../src/lib/offerings/types';
import { validateDealForm } from '../src/lib/deals/client-validate';
import { OfferingsDisabledNotice } from '../src/app/dashboard/deals/_components/offerings-disabled-notice';
import {
  parseDealFilters,
  withoutOfferingFilters,
} from '../src/lib/deals/filters';
import {
  funnelScopeToParams,
  parseFunnelScope,
} from '../src/lib/reports/funnel-scope';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/* ------------------------------------------------------------------ *
 * 1. The mandatory rule is create-only                                *
 * ------------------------------------------------------------------ */

function dealForm(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('name', 'Fixture deal');
  fd.set('stage', 'lead');
  fd.set('amount', '100');
  fd.set('currency', 'INR');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

const PREV = { stage: 'lead', expectedCloseDate: null };

check(
  'create blocks a deal with no offerings',
  Boolean(
    validateDealForm(dealForm(), null, { offeringRule: 'required' }).offeringIds,
  ),
);
check(
  'the block carries a message the form can show, not a bare flag',
  (validateDealForm(dealForm(), null, { offeringRule: 'required' })
    .offeringIds?.[0] ?? '').length > 10,
);
check(
  'create passes with one offering',
  !validateDealForm(dealForm({ offeringIds: A }), null, {
    offeringRule: 'required',
  }).offeringIds,
);
check(
  'create blocks two offerings with no primary marked',
  Boolean(
    validateDealForm(dealForm({ offeringIds: `${A},${B}` }), null, {
      offeringRule: 'required',
    }).offeringIds,
  ),
);
check(
  'create passes two offerings once one is primary',
  !validateDealForm(
    dealForm({ offeringIds: `${A},${B}`, primaryOfferingId: B }),
    null,
    { offeringRule: 'required' },
  ).offeringIds,
);

/* -------- the rule follows the DEAL's history, not the action -------- */

// The asymmetry that makes legacy deals workable. If this ever fails, the
// first person to edit an untagged deal is blocked by a field they did not
// open — the failure mode the no-backfill decision exists to avoid.
check(
  'EDIT of an untagged deal is NOT blocked (no backfill, no forced prompt)',
  !validateDealForm(dealForm(), PREV, {
    offeringRule: offeringRuleFor({ isNewDeal: false, existingTagCount: 0 }),
  }).offeringIds,
);
check(
  'edit stays unblocked even when the caller passes no options object at all',
  !validateDealForm(dealForm()).offeringIds,
);
// THE HOLE THIS RULE EXISTS TO CLOSE. Keyed on create-vs-update, a deal
// created under the mandatory rule could be reopened and emptied — landing in
// exactly the state creation had just refused. The rule is about the deal's
// history, so a deal that HAS tags may not be stripped of them.
check(
  'EDIT of a TAGGED deal cannot empty it — mandatory-on-create actually sticks',
  Boolean(
    validateDealForm(dealForm(), PREV, {
      offeringRule: offeringRuleFor({ isNewDeal: false, existingTagCount: 2 }),
    }).offeringIds,
  ),
);
check(
  'and it says to swap rather than just refusing',
  (validateDealForm(dealForm(), PREV, {
    offeringRule: offeringRuleFor({ isNewDeal: false, existingTagCount: 1 }),
  }).offeringIds?.[0] ?? '').includes('add the right one first'),
);
check(
  're-tagging a tagged deal to a DIFFERENT offering is fine — only emptying is not',
  !validateDealForm(dealForm({ offeringIds: B }), PREV, {
    offeringRule: offeringRuleFor({ isNewDeal: false, existingTagCount: 1 }),
  }).offeringIds,
);
check(
  'offeringRuleFor: new deal is always required',
  offeringRuleFor({ isNewDeal: true, existingTagCount: 0 }) === 'required',
);
check(
  'offeringRuleFor: tagged existing deal is keep, untagged one is unruled',
  offeringRuleFor({ isNewDeal: false, existingTagCount: 3 }) === 'keep' &&
    offeringRuleFor({ isNewDeal: false, existingTagCount: 0 }) === undefined,
);

/* ------------------------------------------------------------------ *
 * 2. Primary is derived, never remembered                             *
 * ------------------------------------------------------------------ */

check('a lone tag is primary without being asked', defaultPrimary([A], null) === A);
check(
  'two tags with no choice have no primary — the caller must ask',
  defaultPrimary([A, B], null) === null,
);
check('an explicit primary inside the selection wins', defaultPrimary([A, B], B) === B);
check(
  'a primary that was un-ticked is dropped, not written onto a row we never insert',
  defaultPrimary([A], B) === A,
);
check(
  'a stale primary with two remaining tags falls back to "ask", not to the first',
  defaultPrimary([A, B], 'ffffffff-ffff-4fff-8fff-ffffffffffff') === null,
);
check(
  'duplicate ids collapse — a double-submit cannot double a deal into its own funnel',
  defaultPrimary([A, A], null) === A,
);
check(
  'empty strings are not offerings',
  defaultPrimary(['', '  '], null) === null,
);

const okSel = validateOfferingSelection({
  offeringIds: [A, A, B],
  primaryOfferingId: A,
});
check(
  'validateOfferingSelection returns the resolved primary, deduped',
  okSel.ok && okSel.primaryOfferingId === A,
);
check(
  'validateOfferingSelection rejects an empty selection',
  !validateOfferingSelection({ offeringIds: [], primaryOfferingId: null }).ok,
);

/* -------- ordering + grouping helpers -------- */

check(
  'grouping always returns every category, empty ones included',
  groupByCategory([{ category: 'product' as const }]).length ===
    OFFERING_CATEGORIES.length,
);
check(
  'sort_order ties break by name, so the list cannot shuffle between renders',
  compareOfferings(
    { category: 'product', sortOrder: 10, name: 'Beta' },
    { category: 'product', sortOrder: 10, name: 'Alpha' },
  ) > 0,
);
check(
  'products sort before services regardless of sort_order',
  compareOfferings(
    { category: 'product', sortOrder: 999, name: 'Z' },
    { category: 'service', sortOrder: 1, name: 'A' },
  ) < 0,
);

/* -------- URL round trips -------- */

check(
  'offering filter round-trips through the deals URL',
  parseDealFilters({ offering: `${A},${B}` }).offeringIds?.length === 2,
);
check(
  'uncategorized=1 parses as a flag',
  parseDealFilters({ uncategorized: '1' }).uncategorized === true,
);
check(
  'a specific offering beats a category toggle — the narrower statement wins',
  parseFunnelScope({ offering: A, category: 'service' }).type === 'offering',
);
check(
  'a typo’d scope degrades to "all", never to a plausible-looking wrong filter',
  parseFunnelScope({ category: 'produkt' }).type === 'all' &&
    parseFunnelScope({ offering: 'not-a-uuid' }).type === 'all',
);
check(
  'uncategorized is reachable as its own funnel scope',
  parseFunnelScope({ category: 'uncategorized' }).type === 'uncategorized',
);
for (const scope of [
  { type: 'all' as const },
  { type: 'category' as const, category: 'product' as const },
  { type: 'offering' as const, offeringId: A },
  { type: 'uncategorized' as const },
]) {
  const back = parseFunnelScope(funnelScopeToParams(scope));
  check(
    `funnel scope "${scope.type}" survives a URL round trip`,
    JSON.stringify(back) === JSON.stringify(scope),
    JSON.stringify(back),
  );
}

/* ------------------------------------------------------------------ *
 * 8a. The workspace switch - pure and source-level                    *
 * ------------------------------------------------------------------ */

const stripped = withoutOfferingFilters(
  parseDealFilters({ offering: A, uncategorized: '1', stage: 'lead', mine: '1' }),
);
check(
  'switch off: a stale ?offering= / ?uncategorized= link is ignored, not applied invisibly',
  stripped.offeringIds === undefined && stripped.uncategorized === undefined,
);
check(
  '...while every other filter in the same URL survives',
  stripped.stages?.[0] === 'lead' && stripped.mine === true,
);

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const dealActions = src('src', 'app', 'dashboard', 'deals', 'actions.ts');
check(
  'source: create only REQUIRES offerings when the workspace has them on',
  /if \(offeringsEnabled\) \{\s*const offeringSelection = validateOfferingSelection\(/.test(
    dealActions,
  ),
);
check(
  'source: create only WRITES tags when the workspace has them on',
  /if \(offeringsEnabled\) \{\s*const offeringIds = await resolveOfferingIds\(/.test(
    dealActions,
  ),
);
// The regression this block exists for. With the switch off the drawer
// renders no picker, the form submits no ids, and an ungated sync would try to
// empty every previously-tagged deal - refusing the entire save.
check(
  'source: the edit drawer tag sync is skipped entirely when the switch is off',
  /if \(offeringsEnabled\) \{\s*await syncDealOfferings\(/.test(dealActions) &&
    (dealActions.match(/syncDealOfferings\(/g) ?? []).length === 1,
);

const offeringActions = src('src', 'app', 'dashboard', 'deals', '[id]', 'offering-actions.ts');
const exportedActions = (offeringActions.match(/export async function \w+/g) ?? []).length;
const gatedActions = (
  offeringActions.match(/if \(!\(await isOfferingsEnabled\(tenant\.id\)\)\)/g) ?? []
).length;
check(
  'source: every detail-card write action refuses when the switch is off',
  exportedActions > 0 && gatedActions === exportedActions,
  `${gatedActions} of ${exportedActions} gated`,
);

const registrySrc = src('src', 'lib', 'reports', 'registry.ts');
check(
  'source: the funnel report is registered behind the offerings flag',
  /'funnel-by-offering':[\s\S]*?requiresFlag: 'offeringsEnabled'/.test(registrySrc),
);
for (const [label, file] of [
  ['reports list', ['src', 'app', 'dashboard', 'reports', 'page.tsx']],
  ['report detail', ['src', 'app', 'dashboard', 'reports', '[reportId]', 'page.tsx']],
  ['report CSV', ['src', 'app', 'dashboard', 'reports', 'actions.ts']],
] as const) {
  check(
    `source: the ${label} checks isReportEnabled`,
    src(...file).includes('isReportEnabled('),
  );
}

// A deal tagged BEFORE the switch went off must say so wherever its
// offerings would have been, instead of the tags silently vanishing. The
// notice renders nothing for an untagged deal - there is nothing to explain.
const NOTICE_TAG = { id: A, name: 'SafeOps360', category: 'product' as const, active: true, isPrimary: true };
check(
  'switch off + untagged deal: no notice at all',
  OfferingsDisabledNotice({ tags: [], canTurnOn: true }) === null,
);
check(
  'switch off + tagged deal: the notice renders',
  OfferingsDisabledNotice({ tags: [NOTICE_TAG], canTurnOn: false }) !== null,
);
const drawerSrc = src('src', 'app', 'dashboard', 'deals', '_components', 'edit-deal-drawer.tsx');
const detailSrc = src('src', 'app', 'dashboard', 'deals', '[id]', 'page.tsx');
check(
  'source: the edit drawer shows the notice when the switch is off',
  /\) : \(\s*(?:\/\/.*\s*)*<OfferingsDisabledNotice/.test(drawerSrc),
);
check(
  'source: the deal page shows the notice in place of the card when off',
  /\) : \(\s*<OfferingsDisabledNotice/.test(detailSrc),
);

/* ------------------------------------------------------------------ *
 * 3-7. Database-backed properties                                     *
 * ------------------------------------------------------------------ */

const SLUG = 'zz-selftest-offerings';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping the database checks.');
    report();
    return;
  }

  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const {
    listDealOfferings,
    listOfferingOptions,
    listOfferingsWithUsage,
    OfferingSyncError,
    seedDefaultOfferings,
    setOfferingActive,
    syncDealOfferings,
  } = await import('../src/lib/offerings/queries');
  const { tenantTransaction } = await import('../src/lib/db-context');
  const { isOfferingsEnabled } = await import('../src/lib/offerings/queries');
  const { setWorkspaceFlags } = await import(
    '../src/lib/workspace-settings/queries'
  );
  const { getReport, isReportEnabled } = await import(
    '../src/lib/reports/registry'
  );
  const { funnelByOfferingRunner } = await import(
    '../src/lib/reports/queries/funnel-by-offering'
  );
  const { listDeals } = await import('../src/lib/deals/queries');

  let tenantId: string | null = null;
  try {
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
    const [t] = (await db.execute(sql`
      INSERT INTO tenants (name, slug)
      VALUES ('ZZ Selftest Offerings', ${SLUG}) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    tenantId = t!.id;
    const tid = tenantId;

    /* ---- 8b. the workspace switch, against a real row ---- */
    const funnelReport = getReport('funnel-by-offering')!;
    check(
      'a brand-new workspace starts with offerings OFF',
      (await runWithSystemContext(tid, () => isOfferingsEnabled(tid))) === false,
    );
    check(
      '...so the funnel report does not exist for it',
      (await runWithSystemContext(tid, () =>
        isReportEnabled(tid, funnelReport),
      )) === false,
    );
    check(
      'reports with no flag are unaffected by the switch',
      (await runWithSystemContext(tid, () =>
        isReportEnabled(tid, getReport('pipeline-by-stage')!),
      )) === true,
    );
    await runWithSystemContext(tid, () =>
      setWorkspaceFlags(tid, { offeringsEnabled: true }),
    );
    check(
      'switching it on is visible immediately, report included',
      (await runWithSystemContext(tid, () => isOfferingsEnabled(tid))) &&
        (await runWithSystemContext(tid, () =>
          isReportEnabled(tid, funnelReport),
        )),
    );

    await runWithSystemContext(tid, () => seedDefaultOfferings(tid));

    const catalog = await runWithSystemContext(tid, () =>
      listOfferingsWithUsage(tid),
    );
    check(
      'a fresh workspace gets the full seed catalog',
      catalog.length === 14,
      `${catalog.length} offerings`,
    );
    check(
      'the seed splits 9 products / 5 services',
      catalog.filter((o) => o.category === 'product').length === 9 &&
        catalog.filter((o) => o.category === 'service').length === 5,
    );
    check(
      'seeding twice is a no-op, not a duplicate catalog',
      await runWithSystemContext(tid, async () => {
        await seedDefaultOfferings(tid);
        return (await listOfferingsWithUsage(tid)).length === 14;
      }),
    );

    const idOf = (name: string): string => {
      const row = catalog.find((o) => o.name === name);
      if (!row) throw new Error(`seed missing ${name}`);
      return row.id;
    };
    const safeOps = idOf('SafeOps360');
    const anytimeHire = idOf('AnytimeHire');
    const implementation = idOf('Implementation Services');
    const procureFlow = idOf('ProcureFlow');
    const cadence = idOf('Cadence');

    /**
     * The fixture. Amounts are distinct and non-round so a wrong SUM cannot
     * coincidentally equal a right one, and every deal exists to make one
     * assertion decidable.
     *
     *   D1  proposal      3,10,000  SafeOps360 (primary)
     *   D2  negotiation  11,30,000  SafeOps360 (primary) + Implementation  <- cross-category bundle
     *   D3  won           7,70,000  AnytimeHire (primary) + Cadence        <- two PRODUCTS
     *   D4  qualified     5,50,000  ProcureFlow (primary)   <- ProcureFlow is retired later
     *   D5  proposal      9,90,000  UNTAGGED                <- the legacy backlog
     *
     * The two bundles are different on purpose. D2 crosses categories, which
     * is what proves a deal reaches both a Product and a Service funnel. D3
     * carries two tags in the SAME category, which is what proves the
     * category toggle counts a deal once rather than once per matching tag —
     * a distinction a single cross-category bundle cannot detect.
     */
    const deal = async (
      name: string,
      stage: string,
      amountMinor: number,
    ): Promise<string> => {
      const [row] = (await db.execute(sql`
        INSERT INTO deals (tenant_id, name, stage, amount_minor, currency,
                           expected_close_date)
        VALUES (${tid}::uuid, ${name}, ${stage}::deal_stage,
                ${amountMinor}::bigint, 'INR', CURRENT_DATE + 30)
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return row!.id;
    };
    const tag = async (
      dealId: string,
      offeringId: string,
      isPrimary: boolean,
    ): Promise<void> => {
      await db.execute(sql`
        INSERT INTO deal_offerings (tenant_id, deal_id, offering_id, is_primary)
        VALUES (${tid}::uuid, ${dealId}::uuid, ${offeringId}::uuid, ${isPrimary})
      `);
    };

    const d1 = await deal('D1 SafeOps', 'proposal', 3_10_000);
    const d2 = await deal('D2 Bundle', 'negotiation', 11_30_000);
    const d3 = await deal('D3 Hire Won', 'won', 7_70_000);
    const d4 = await deal('D4 Procure', 'qualified', 5_50_000);
    const d5 = await deal('D5 Untagged', 'proposal', 9_90_000);

    await tag(d1, safeOps, true);
    await tag(d2, safeOps, true);
    await tag(d2, implementation, false);
    await tag(d3, anytimeHire, true);
    await tag(d3, cadence, false);
    await tag(d4, procureFlow, true);

    const ALL_VALUE = 3_10_000 + 11_30_000 + 7_70_000 + 5_50_000 + 9_90_000;

    // OFF deletes nothing. A workspace that switches off for a quarter must get
    // its tags - and so its funnel history - back intact.
    const tagCount = async (): Promise<number> =>
      Number(
        (
          (await db.execute(
            sql`SELECT count(*)::int AS n FROM deal_offerings WHERE tenant_id = ${tid}::uuid`,
          )) as unknown as Array<{ n: number }>
        )[0]!.n,
      );
    const tagsBeforeOff = await tagCount();
    await runWithSystemContext(tid, () =>
      setWorkspaceFlags(tid, { offeringsEnabled: false }),
    );
    const tagsWhileOff = await tagCount();
    await runWithSystemContext(tid, () =>
      setWorkspaceFlags(tid, { offeringsEnabled: true }),
    );
    const tagsAfterOn = await tagCount();
    check(
      'switching offerings OFF deletes no tags, and ON brings them all back',
      tagsBeforeOff === 6 && tagsWhileOff === 6 && tagsAfterOn === 6,
      `${tagsBeforeOff} -> ${tagsWhileOff} -> ${tagsAfterOn}`,
    );

    /* ---- 3. exactly one primary, enforced by the database ---- */
    let secondPrimaryRejected = false;
    try {
      await db.execute(sql`
        UPDATE deal_offerings SET is_primary = true
        WHERE deal_id = ${d2}::uuid AND offering_id = ${implementation}::uuid
      `);
    } catch {
      secondPrimaryRejected = true;
    }
    check(
      'the database refuses a second primary on one deal, app logic or not',
      secondPrimaryRejected,
    );

    // And the supported path — clear, then set — works, which is what the
    // set-primary action does inside one transaction.
    await db.execute(sql`
      UPDATE deal_offerings SET is_primary = false WHERE deal_id = ${d2}::uuid
    `);
    await db.execute(sql`
      UPDATE deal_offerings SET is_primary = true
      WHERE deal_id = ${d2}::uuid AND offering_id = ${implementation}::uuid
    `);
    const d2Tags = await runWithSystemContext(tid, () =>
      listDealOfferings(tid, d2),
    );
    check(
      'clear-then-set moves the primary and leaves exactly one',
      d2Tags.filter((o) => o.isPrimary).length === 1 &&
        d2Tags.find((o) => o.isPrimary)?.name === 'Implementation Services',
      JSON.stringify(d2Tags.map((o) => [o.name, o.isPrimary])),
    );
    check(
      'the primary sorts first, so the list column reads it without a scan',
      d2Tags[0]?.isPrimary === true,
    );
    // Put it back so the rest of the fixture reads as documented.
    await db.execute(sql`
      UPDATE deal_offerings SET is_primary = false WHERE deal_id = ${d2}::uuid
    `);
    await db.execute(sql`
      UPDATE deal_offerings SET is_primary = true
      WHERE deal_id = ${d2}::uuid AND offering_id = ${safeOps}::uuid
    `);

    /* ---- 4 + 7. the funnel, the bundle, and the hand sum ---- */
    const runFunnel = (scope: Parameters<typeof funnelByOfferingRunner>[1]['scope']) =>
      runWithSystemContext(tid, () =>
        funnelByOfferingRunner(
          tid,
          { range: 'all_time', owner: { type: 'all' }, scope },
          { currentUserId: 'system' },
        ),
      );

    const all = await runFunnel({ type: 'all' });
    check(
      'unscoped, the funnel is every deal — tagged and not',
      all.meta.totalCount === 5 &&
        all.rows.reduce((s, r) => s + r.totalAmountMinor, 0) === ALL_VALUE,
      `${all.meta.totalCount} deals / ${all.rows.reduce((s, r) => s + r.totalAmountMinor, 0)}`,
    );

    const safeOpsFunnel = await runFunnel({ type: 'offering', offeringId: safeOps });
    const byStage = (
      rows: typeof safeOpsFunnel.rows,
      stage: string,
    ): { count: number; totalAmountMinor: number } =>
      rows.find((r) => r.stage === stage) ?? { count: 0, totalAmountMinor: 0 };

    check(
      'a single-offering funnel splits count + value across the right stages',
      byStage(safeOpsFunnel.rows, 'proposal').count === 1 &&
        byStage(safeOpsFunnel.rows, 'proposal').totalAmountMinor === 3_10_000 &&
        byStage(safeOpsFunnel.rows, 'negotiation').count === 1 &&
        byStage(safeOpsFunnel.rows, 'negotiation').totalAmountMinor === 11_30_000,
      JSON.stringify(
        safeOpsFunnel.rows.filter((r) => r.count > 0).map((r) => [r.stage, r.count, r.totalAmountMinor]),
      ),
    );
    check(
      'empty stages are still rendered as zeroes, so the axis is stable',
      safeOpsFunnel.rows.length === 7 &&
        byStage(safeOpsFunnel.rows, 'won').count === 0,
    );

    // THE bundle property. D2 carries SafeOps360 (primary) AND Implementation
    // Services (not primary). It must appear, at full value, in both.
    const implFunnel = await runFunnel({
      type: 'offering',
      offeringId: implementation,
    });
    check(
      'a bundle deal appears in its NON-primary offering’s funnel too',
      implFunnel.meta.totalCount === 1 &&
        byStage(implFunnel.rows, 'negotiation').totalAmountMinor === 11_30_000,
      `${implFunnel.meta.totalCount} deals`,
    );
    check(
      'and at its FULL value in both — the amount is not split between tags',
      byStage(safeOpsFunnel.rows, 'negotiation').totalAmountMinor ===
        byStage(implFunnel.rows, 'negotiation').totalAmountMinor,
    );

    const productFunnel = await runFunnel({ type: 'category', category: 'product' });
    check(
      'the Product toggle counts a deal ONCE even when two of its tags are products',
      productFunnel.meta.totalCount === 4 &&
        productFunnel.rows.find((r) => r.stage === 'won')?.count === 1,
      `${productFunnel.meta.totalCount} deals`,
    );
    const serviceFunnel = await runFunnel({ type: 'category', category: 'service' });
    check(
      'the Service toggle finds the bundle through its service tag',
      serviceFunnel.meta.totalCount === 1,
      `${serviceFunnel.meta.totalCount} deals`,
    );

    /* ---- rollup equals the hand sum ---- */
    const rollup = new Map(
      all.extras!.rollup.map((r) => [r.offeringName, r]),
    );
    check(
      'rollup: SafeOps360 = D1 + D2, by hand',
      rollup.get('SafeOps360')?.totalAmountMinor === 3_10_000 + 11_30_000 &&
        rollup.get('SafeOps360')?.dealCount === 2,
      JSON.stringify(rollup.get('SafeOps360')),
    );
    check(
      'rollup: AnytimeHire is won, so its total counts but nothing is still open',
      rollup.get('AnytimeHire')?.totalAmountMinor === 7_70_000 &&
        rollup.get('AnytimeHire')?.openAmountMinor === 0 &&
        rollup.get('AnytimeHire')?.openDealCount === 0,
      JSON.stringify(rollup.get('AnytimeHire')),
    );
    check(
      'rollup: Implementation Services carries the bundle at full value',
      rollup.get('Implementation Services')?.totalAmountMinor === 11_30_000,
    );
    check(
      'rollup is sorted by value, descending',
      all.extras!.rollup.every(
        (r, i) =>
          i === 0 ||
          all.extras!.rollup[i - 1]!.totalAmountMinor >= r.totalAmountMinor,
      ),
    );
    check(
      'an offering nobody sells is absent from the rollup, not a row of zeroes',
      !rollup.has('VisitOS'),
    );
    // The intentional over-sum, asserted so nobody "fixes" it later.
    const rollupTotal = all.extras!.rollup.reduce(
      (s, r) => s + r.totalAmountMinor,
      0,
    );
    check(
      'rollup rows sum to MORE than tagged pipeline — by exactly the two bundles',
      rollupTotal === ALL_VALUE - 9_90_000 + 11_30_000 + 7_70_000,
      `${rollupTotal}`,
    );
    check(
      'and the report says how many deals cause it',
      all.extras!.overlapDealCount === 2,
      `${all.extras!.overlapDealCount}`,
    );

    /* ---- 5. tagged + uncategorized = all deals ---- */
    check(
      'the Uncategorized total is the untagged deal, exactly',
      all.extras!.uncategorized.dealCount === 1 &&
        all.extras!.uncategorized.totalAmountMinor === 9_90_000,
      JSON.stringify(all.extras!.uncategorized),
    );
    check(
      'coverage arithmetic closes: tagged + uncategorized = all',
      all.extras!.allDeals.dealCount === 5 &&
        all.extras!.allDeals.totalAmountMinor === ALL_VALUE,
    );
    const uncatFunnel = await runFunnel({ type: 'uncategorized' });
    check(
      'the Uncategorized scope returns the same population as the coverage tile',
      uncatFunnel.meta.totalCount === all.extras!.uncategorized.dealCount,
    );

    // The deals-list filter must agree with the report, or the "open the
    // Uncategorized list" link lands on a different set than the number
    // that sent the user there.
    const uncatList = await runWithSystemContext(tid, () =>
      listDeals(tid, { size: 100, filters: { uncategorized: true } }),
    );
    check(
      'the deals-list Uncategorized filter finds the same deals the report counts',
      uncatList.items.length === 1 && uncatList.items[0]?.id === d5,
      `${uncatList.items.length} deals`,
    );
    const taggedList = await runWithSystemContext(tid, () =>
      listDeals(tid, { size: 100, filters: { offeringIds: [safeOps] } }),
    );
    check(
      'the list’s offering filter matches ALL tags, so the bundle is in it',
      taggedList.items.length === 2 &&
        taggedList.items.some((d) => d.id === d2),
      `${taggedList.items.length} deals`,
    );
    check(
      'the list filter returns one row per deal, not one per matching tag',
      new Set(taggedList.items.map((d) => d.id)).size === taggedList.items.length,
    );

    /* ---- the list column: primary only, with a +N ---- */
    const listAll = await runWithSystemContext(tid, () =>
      listDeals(tid, { size: 100 }),
    );
    const rowOf = (id: string) => listAll.items.find((d) => d.id === id)!;
    check(
      'the row carries EVERY tag, primary first — what the drawer prefills from',
      rowOf(d2).offerings.length === 2 &&
        rowOf(d2).offerings[0]!.isPrimary === true &&
        rowOf(d2).offerings.map((o) => o.name).sort().join('|') ===
          'Implementation Services|SafeOps360',
      JSON.stringify(rowOf(d2).offerings.map((o) => [o.name, o.isPrimary])),
    );
    check(
      'the column shows the PRIMARY offering, and counts the rest',
      primaryOfferingOf(rowOf(d2).offerings)?.name === 'SafeOps360' &&
        rowOf(d2).offerings.length === 2,
      `${primaryOfferingOf(rowOf(d2).offerings)?.name}`,
    );
    check(
      'an untagged deal has no tags, which the cell renders as Uncategorized',
      rowOf(d5).offerings.length === 0 &&
        primaryOfferingOf(rowOf(d5).offerings) === null,
    );
    check(
      'the offering joins do not multiply the page',
      listAll.items.length === 5,
      `${listAll.items.length} rows`,
    );

    /* ---- 8. the drawer's whole-selection sync ---- */

    const sync = (
      dealId: string,
      offeringIds: string[],
      primaryOfferingId: string | null = null,
    ) =>
      runWithSystemContext(tid, () =>
        tenantTransaction((tx) =>
          syncDealOfferings(tx, {
            tenantId: tid,
            dealId,
            offeringIds,
            primaryOfferingId,
          }),
        ),
      );
    const tagsOf = (dealId: string) =>
      runWithSystemContext(tid, () => listDealOfferings(tid, dealId));
    const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
      try {
        await fn();
        return null;
      } catch (err) {
        return err instanceof OfferingSyncError ? err.message : `WRONG: ${err}`;
      }
    };

    // Emptying a TAGGED deal is refused — the hole that made
    // mandatory-on-create meaningless. D1 carries SafeOps360.
    const emptied = await refused(() => sync(d1, []));
    check(
      'sync refuses to empty a tagged deal, so create-time mandatory sticks',
      emptied !== null && !emptied.startsWith('WRONG'),
      emptied ?? 'not refused',
    );
    check(
      '…and the deal is untouched afterwards',
      (await tagsOf(d1)).length === 1,
    );

    // An UNTAGGED legacy deal saved with no offerings is fine — that is the
    // whole no-backfill promise. D5 is the legacy row.
    check(
      'sync leaves an untagged legacy deal alone rather than blocking its save',
      (await refused(() => sync(d5, []))) === null &&
        (await tagsOf(d5)).length === 0,
    );

    // Swapping is the supported way to correct a mistag: one call, both edits.
    await sync(d1, [anytimeHire]);
    const swapped = await tagsOf(d1);
    check(
      'sync swaps a lone tag in one save, and the new one is primary',
      swapped.length === 1 &&
        swapped[0]!.name === 'AnytimeHire' &&
        swapped[0]!.isPrimary === true,
      JSON.stringify(swapped.map((o) => [o.name, o.isPrimary])),
    );
    await sync(d1, [safeOps]); // restore the documented fixture

    // Adding, removing and re-pointing the primary in one submit.
    await sync(d2, [safeOps, anytimeHire], anytimeHire);
    const resynced = await tagsOf(d2);
    check(
      'sync adds, removes and moves the primary in a single save',
      resynced.length === 2 &&
        resynced.filter((o) => o.isPrimary).length === 1 &&
        resynced.find((o) => o.isPrimary)?.name === 'AnytimeHire' &&
        !resynced.some((o) => o.name === 'Implementation Services'),
      JSON.stringify(resynced.map((o) => [o.name, o.isPrimary])),
    );
    await sync(d2, [safeOps, implementation], safeOps); // restore

    // Re-submitting an unchanged selection must not churn rows — the drawer
    // sends the full selection on EVERY save, including ones that never
    // touched offerings.
    const before = await tagsOf(d2);
    await sync(d2, [safeOps, implementation], safeOps);
    const after = await tagsOf(d2);
    check(
      'an unchanged selection rewrites nothing',
      JSON.stringify(before.map((o) => o.linkId).sort()) ===
        JSON.stringify(after.map((o) => o.linkId).sort()),
    );

    /* ---- 6. retiring is not deleting ---- */
    await runWithSystemContext(tid, () =>
      setOfferingActive(tid, procureFlow, false),
    );
    const picker = await runWithSystemContext(tid, () =>
      listOfferingOptions(tid),
    );
    check(
      'a retired offering disappears from the tag picker',
      !picker.some((o) => o.id === procureFlow),
    );
    check(
      '…but the picker still offers everything else',
      picker.length === 13,
      `${picker.length}`,
    );
    const d4Tags = await runWithSystemContext(tid, () =>
      listDealOfferings(tid, d4),
    );
    check(
      'the retired offering is still ON the deal that carried it, flagged inactive',
      d4Tags.length === 1 &&
        d4Tags[0]!.name === 'ProcureFlow' &&
        d4Tags[0]!.active === false,
      JSON.stringify(d4Tags),
    );
    const afterRetire = await runFunnel({
      type: 'offering',
      offeringId: procureFlow,
    });
    check(
      'a retired offering keeps its funnel — reports do not lose history',
      afterRetire.meta.totalCount === 1 &&
        byStage(afterRetire.rows, 'qualified').totalAmountMinor === 5_50_000,
    );
    const afterRollup = (await runFunnel({ type: 'all' })).extras!.rollup;
    check(
      'and it still appears in the rollup, marked retired rather than dropped',
      afterRollup.some((r) => r.offeringName === 'ProcureFlow' && !r.active),
    );

    // The trap this feature would otherwise fall into: D4's only tag is now
    // RETIRED. Saving D4 from the drawer resubmits that id, and an
    // implementation that ran every submitted id through the active-only
    // filter would drop it — silently untagging the deal on an edit that
    // never touched offerings.
    await sync(d4, [procureFlow], procureFlow);
    const d4AfterSave = await tagsOf(d4);
    check(
      'a RETIRED tag already on a deal survives a save that resubmits it',
      d4AfterSave.length === 1 &&
        d4AfterSave[0]!.name === 'ProcureFlow' &&
        d4AfterSave[0]!.active === false,
      JSON.stringify(d4AfterSave.map((o) => [o.name, o.active])),
    );
    // …but it still cannot be added to a deal that doesn't already carry it.
    const addRetired = await refused(() =>
      sync(d3, [anytimeHire, cadence, procureFlow], anytimeHire),
    );
    check(
      '…but a retired offering still cannot be added to a different deal',
      addRetired !== null && !addRetired.startsWith('WRONG'),
      addRetired ?? 'not refused',
    );

    // The structural half of "never hard-delete": ON DELETE RESTRICT.
    let hardDeleteRefused = false;
    try {
      await db.execute(
        sql`DELETE FROM offerings WHERE id = ${procureFlow}::uuid`,
      );
    } catch {
      hardDeleteRefused = true;
    }
    check(
      'the FK refuses to delete a referenced offering — no orphaned tags',
      hardDeleteRefused,
    );
    // An UNreferenced one is still deletable; RESTRICT protects history, it
    // is not a blanket ban that would strand a typo'd catalog entry.
    let unusedDeleted = false;
    try {
      await db.execute(sql`DELETE FROM offerings WHERE id = ${idOf('VisitOS')}::uuid`);
      unusedDeleted = true;
    } catch {
      unusedDeleted = false;
    }
    check(
      'an offering nothing references can still be removed',
      unusedDeleted,
    );

    /* ---- usage counts drive the Settings warning ---- */
    const usage = new Map(
      (await runWithSystemContext(tid, () => listOfferingsWithUsage(tid))).map(
        (o) => [o.name, o.dealCount],
      ),
    );
    check(
      'Settings usage counts match the tags, zero included',
      usage.get('SafeOps360') === 2 &&
        usage.get('Implementation Services') === 1 &&
        usage.get('Cadence') === 1 &&
        usage.get('LUMINEX') === 0,
      JSON.stringify([
        usage.get('SafeOps360'),
        usage.get('Implementation Services'),
        usage.get('Cadence'),
        usage.get('LUMINEX'),
      ]),
    );

    /* ---- soft-deleted deals leave every number ---- */
    await db.execute(
      sql`UPDATE deals SET deleted_at = now() WHERE id = ${d1}::uuid`,
    );
    const afterDelete = await runFunnel({ type: 'offering', offeringId: safeOps });
    check(
      'a soft-deleted deal leaves the funnel and the rollup',
      afterDelete.meta.totalCount === 1 &&
        (await runFunnel({ type: 'all' })).extras!.rollup.find(
          (r) => r.offeringName === 'SafeOps360',
        )?.totalAmountMinor === 11_30_000,
    );
  } catch (err) {
    check('database checks ran', false, String(err));
  } finally {
    // Drop the fixture BEFORE closing the connection — the other way round
    // runs the cleanup against an ended client and leaves the tenant behind.
    if (tenantId) {
      try {
        await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
      } catch (err) {
        console.error(
          `WARNING: could not remove the fixture tenant ${SLUG} — delete it by hand. ${String(err)}`,
        );
      }
    }
    await client.end({ timeout: 5 });
    report();
  }
}

function report(): void {
  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
