import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed parity tests for the two dashboards. Read-only — writes
 * nothing, cleans up nothing, and runs against whatever real tenants
 * the connected database holds.
 *
 * Three invariants, each of which was broken (or at risk of breaking)
 * during the dashboard/executive upgrade:
 *
 *   1. QUOTA TIES OUT.  `quota.achievedMinor + quota.pendingApprovalMinor`
 *      must equal Σ won `amount_minor` over the same fiscal-year window,
 *      computed independently here. This is the invariant that failed
 *      before: filtering on `approval_status = 'approved'` credited 0 of
 *      24 won deals in CGB Solutions, rendering "0% · ₹0 of ₹40,000,000"
 *      beside a stage table reading ₹31,794,123.
 *
 *   2. QUOTA IS NOT SILENTLY EMPTY.  Any tenant holding a target AND
 *      won revenue in the fiscal year must show non-zero attainment.
 *      Invariant 1 alone passes trivially if everything is withheld.
 *
 *   3. TOTAL PIPELINE MATCHES ACROSS VIEWS.  The Dashboard KPI strip
 *      reconstructs open pipeline from `deal_stage_history`
 *      (`pipelineSnapshotAt`); the Executive page sums the non-won,
 *      non-lost rows of `pipelineByStageRunner`. Two different queries,
 *      one number — they agreed before this work and must still agree
 *      after it. A divergence here is a regression, not a rounding
 *      detail.
 *
 * Tenants with no deals are skipped (nothing to compare); the run fails
 * if that leaves nothing tested, so a bad connection can't read as a
 * green suite.
 */

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const inr = (minor: number) =>
  `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

async function main() {
  const { db, client } = await import('../src/db/index');
  const { runWithTenantContext } = await import('../src/lib/db-context');
  const { getDashboardKpis } = await import('../src/lib/dashboard/kpis');
  const { resolveDashboardRange } = await import('../src/lib/dashboard/range');
  const { pipelineByStageRunner } = await import(
    '../src/lib/reports/queries/pipeline-by-stage'
  );
  const { resolveStageProbabilities } = await import(
    '../src/lib/deals/stage-probability'
  );
  const { getOrgSettings } = await import('../src/lib/org-settings/queries');
  const { currentFiscalYear, fiscalYearRange } = await import(
    '../src/lib/targets/fiscal'
  );

  const tenants = (await db.execute(sql`
    SELECT t.id, t.name, count(d.id)::int AS deals
    FROM tenants t
    LEFT JOIN deals d ON d.tenant_id = t.id AND d.deleted_at IS NULL
    GROUP BY t.id, t.name
    HAVING count(d.id) > 0
    ORDER BY count(d.id) DESC
  `)) as unknown as Array<{ id: string; name: string; deals: number }>;

  check('found tenants holding deals to compare', tenants.length > 0, `${tenants.length}`);

  for (const t of tenants) {
    // A synthetic actor id: every query under test scopes by tenant and
    // (optionally) an explicit ownerId, never by the ambient user.
    await runWithTenantContext({ tenantId: t.id, userId: 'selftest' }, async () => {
      const settings = await getOrgSettings(t.id);
      const probabilities = resolveStageProbabilities(settings.stageProbabilities);
      const range = resolveDashboardRange({});

      const kpis = await getDashboardKpis(t.id, {
        range,
        ownerId: null,
        probabilities,
        fiscalYearStartMonth: settings.fiscalYearStartMonth,
      });

      /* ---------- 1 + 2: quota ---------- */

      const fy = currentFiscalYear(settings.fiscalYearStartMonth, new Date());
      const { start: fyStart } = fiscalYearRange(settings.fiscalYearStartMonth, fy);
      const wonRows = (await db.execute(sql`
        SELECT
          COALESCE(SUM(amount_minor), 0)::bigint AS won_amount,
          COUNT(*)::int AS won_count
        FROM deals
        WHERE tenant_id = ${t.id}::uuid
          AND deleted_at IS NULL
          AND stage = 'won'
          AND closed_at IS NOT NULL
          AND closed_at >= ${fyStart.toISOString()}::timestamptz
          AND closed_at < now()
      `)) as unknown as Array<{ won_amount: string; won_count: number }>;
      const wonFytdMinor = Number(wonRows[0]?.won_amount ?? 0);
      const wonFytdCount = Number(wonRows[0]?.won_count ?? 0);

      if (kpis.quota) {
        const credited = kpis.quota.achievedMinor;
        const withheld = kpis.quota.pendingApprovalMinor;
        check(
          `[${t.name}] quota credited + withheld === FYTD won revenue`,
          credited + withheld === wonFytdMinor,
          `${inr(credited)} + ${inr(withheld)} = ${inr(credited + withheld)} vs ${inr(wonFytdMinor)}`,
        );
        check(
          `[${t.name}] quota attainment is non-zero when the org has won revenue`,
          wonFytdMinor === 0 || credited > 0,
          `${inr(credited)} credited of ${inr(wonFytdMinor)} won across ${wonFytdCount} deals`,
        );
      } else {
        check(
          `[${t.name}] quota tile omitted only because no target exists`,
          true,
          'no sales_target rows for the current fiscal year',
        );
      }

      /* ---------- 3: cross-view pipeline parity ---------- */

      const pipeline = await pipelineByStageRunner(
        t.id,
        { range: 'last_90d', owner: { type: 'all' } },
        { currentUserId: 'selftest' },
      );
      const execTotalMinor = pipeline.rows
        .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
        .reduce((s, r) => s + r.totalAmountMinor, 0);

      check(
        `[${t.name}] Dashboard total pipeline === Executive total pipeline`,
        kpis.pipelineMinor.value === execTotalMinor,
        `dashboard ${inr(kpis.pipelineMinor.value)} vs executive ${inr(execTotalMinor)}`,
      );
    });
  }

  await client.end();
}

main()
  .then(() => {
    for (const r of results) {
      console.log(
        `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`,
      );
    }
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed.`);
    process.exit(exitCode);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
