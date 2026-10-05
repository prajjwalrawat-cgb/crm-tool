/**
 * Database half of selftest-incentives — loaded only when DATABASE_URL is
 * set. Builds two throwaway tenants with hand-built deals whose correct
 * answers are known, and drops them afterwards.
 *
 * The fixture for spoc-a, FY2026 on a January fiscal year:
 *   A  closed 2025-11-15, split 1 Cr (2025) + 4 Cr (2026), margin 20%
 *        → 4 Cr PRIOR-YEAR (carry-forward recognised in 2026)
 *   B  closed 2026-03-10, no split, 6 Cr, margin 15%   → 6 Cr NET-NEW
 *   C  won, no close date, 1 Cr                         → excluded, flagged
 *   D  closed 2026-04-01, 0.5 Cr, no margin             → net-new, margin unknown
 *   F  closed 2026-05-01, 3 Cr, pending approval        → not credited
 *   E  owned by spoc-b                                  → not spoc-a's
 *
 *   prior 4, net-new 6.5, blended margin (0.8 + 0.9) / 10 = 0.17
 */
import { sql } from 'drizzle-orm';

type Check = (name: string, ok: boolean, detail?: string) => void;

const SLUG_A = 'zz-selftest-incentives-a';
const SLUG_B = 'zz-selftest-incentives-b';
const CR = 1_000_000_000; // paise per crore

export async function runDatabaseChecks(check: Check): Promise<void> {
  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const { createPlan, updatePlan, recordManualActuals, applyBulkChangeToPlans } = await import(
    '../src/lib/incentives/mutations'
  );
  const { loadPlanForViewer, latestActualsForPlans, listVersions, getPlanRow, actualsHistory } = await import(
    '../src/lib/incentives/queries'
  );
  const { recomputeTenant } = await import('../src/lib/inngest/workflows/incentive-actuals-nightly');
  const { toStoredTerms } = await import('../src/lib/incentives/terms');
  const { WORKBOOK_DEFAULT_TERMS, calculateIncentive } = await import('../src/lib/incentives/engine');
  const { actualsInput } = await import('../src/lib/incentives/types');

  const terms = toStoredTerms(WORKBOOK_DEFAULT_TERMS);
  const FY = 2026;

  try {
    await db.execute(sql`DELETE FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`);
    const [ta] = (await db.execute(sql`
      INSERT INTO tenants (name, slug) VALUES ('ZZ Selftest Incentives A', ${SLUG_A}) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const [tb] = (await db.execute(sql`
      INSERT INTO tenants (name, slug) VALUES ('ZZ Selftest Incentives B', ${SLUG_B}) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const tid = ta!.id;
    const tidB = tb!.id;
    await db.execute(sql`
      INSERT INTO organization_settings (tenant_id, fiscal_year_start_month) VALUES (${tid}::uuid, 1)
      ON CONFLICT (tenant_id) DO UPDATE SET fiscal_year_start_month = 1
    `);

    const deal = async (
      name: string,
      owner: string,
      amountCr: number,
      closedAt: string | null,
      marginBps: number | null,
      approval = 'none',
    ): Promise<string> => {
      const [r] = (await db.execute(sql`
        INSERT INTO deals (tenant_id, name, stage, amount_minor, currency, owner_id, closed_at, margin_bps, approval_status, expected_close_date)
        VALUES (${tid}::uuid, ${name}, 'won', ${Math.round(amountCr * CR)}, 'INR', ${owner},
                ${closedAt}::timestamptz, ${marginBps}, ${approval}::deal_approval_status,
                -- chk_close_date_required (0060): a won deal needs an expected
                -- close date. The incentive split keys on closed_at, not this.
                ${(closedAt ?? '2026-06-30').slice(0, 10)}::date)
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return r!.id;
    };
    const dealA = await deal('A carry-forward', 'spoc-a', 5, '2025-11-15T00:00:00Z', 2000);
    await db.execute(sql`
      INSERT INTO deal_value_splits (tenant_id, deal_id, element_index, component, year_index, period_start, period_end, amount_minor)
      VALUES (${tid}::uuid, ${dealA}::uuid, 1, 'license', 1, '2025-01-01', '2026-01-01', ${1 * CR}),
             (${tid}::uuid, ${dealA}::uuid, 1, 'license', 2, '2026-01-01', '2027-01-01', ${4 * CR})
    `);
    await deal('B net-new', 'spoc-a', 6, '2026-03-10T00:00:00Z', 1500);
    await deal('C no close date', 'spoc-a', 1, null, 2000);
    await deal('D no margin', 'spoc-a', 0.5, '2026-04-01T00:00:00Z', null);
    await deal('F pending', 'spoc-a', 3, '2026-05-01T00:00:00Z', 2000, 'pending');
    await deal('E other rep', 'spoc-b', 2, '2026-02-01T00:00:00Z', 2000);

    await runWithSystemContext(tid, async () => {
      const a = await createPlan({ tenantId: tid, actorId: 'admin-1', userId: 'spoc-a', fiscalYear: FY, terms, status: 'active', actualsSource: 'computed' });
      const b = await createPlan({ tenantId: tid, actorId: 'admin-1', userId: 'spoc-b', fiscalYear: FY, terms, status: 'active' });
      check('db: admin can create a plan per resource per FY', a.ok && b.ok);
      if (!a.ok || !b.ok) return;
      const planA = a.value.planId;
      const planB = b.value.planId;

      const dup = await createPlan({ tenantId: tid, actorId: 'admin-1', userId: 'spoc-a', fiscalYear: FY, terms });
      check('db: a second plan for the same resource + FY is refused', !dup.ok);

      /* ---- isolation ---- */
      const asSpocB = await loadPlanForViewer(tid, { userId: 'spoc-b', role: 'member' }, planA, 1);
      check('db: a SPOC cannot read another SPOC’s plan', asSpocB === null);
      const asSpocA = await loadPlanForViewer(tid, { userId: 'spoc-a', role: 'member' }, planA, 1);
      check('db: a SPOC can read their own plan', asSpocA?.plan.id === planA);
      const asManager = await loadPlanForViewer(tid, { userId: 'mgr', role: 'manager' }, planA, 1);
      check('db: a manager can read the team’s plans', asManager?.plan.id === planA);

      /* ---- computed actuals ---- */
      const now = new Date('2026-10-05T03:00:00Z');
      const n = await recomputeTenant(tid, now);
      check('db: only active + computed plans are recomputed', n === 1, `recomputed ${n}`);
      const latest = (await latestActualsForPlans(tid, [{ id: planA, actualsSource: 'computed' }])).get(planA);
      check('db: carry-forward deal lands in prior-year (4 Cr)', Number(latest?.priorYearRevenueCr) === 4, latest?.priorYearRevenueCr);
      check('db: this-FY deals land in net-new (6 + 0.5 Cr)', Number(latest?.netNewRevenueCr) === 6.5, latest?.netNewRevenueCr);
      check('db: blended margin over margin-known revenue = 0.17', Number(latest?.blendedMarginPct) === 0.17, latest?.blendedMarginPct);
      const d = (latest?.details ?? {}) as Record<string, number>;
      check('db: the deal with no close date is excluded AND flagged', d.untaggedDeals === 1);
      check('db: the deal with no margin is flagged', d.marginUnknownDeals === 1);
      check('db: the pending-approval deal is not credited, and is counted', d.pendingApprovalDeals === 1);
      check('db: another rep’s deal is not counted', d.countedDeals === 3, `counted ${d.countedDeals}`);

      await recomputeTenant(tid, now);
      const history = await actualsHistory(tid, planA);
      check('db: re-running the same day replaces, not stacks (1 computed row)', history.filter((h) => h.source === 'computed').length === 1);
      const again = (await latestActualsForPlans(tid, [{ id: planA, actualsSource: 'computed' }])).get(planA);
      check('db: re-run gives identical figures (no double counting)', again?.netNewRevenueCr === latest?.netNewRevenueCr && again?.priorYearRevenueCr === latest?.priorYearRevenueCr);

      /* ---- end to end through the stored row: same figures as the pure engine ---- */
      const viaDb = calculateIncentive(asSpocA!.plan.terms, actualsInput(again!));
      const direct = calculateIncentive(WORKBOOK_DEFAULT_TERMS, { priorYearRevenueCr: 4, netNewRevenueCr: 6.5, blendedMarginPct: 0.17 });
      check('db: stored plan + stored actuals compute identically to the engine', JSON.stringify(viaDb) === JSON.stringify(direct));

      /* ---- source switching is explicit ---- */
      await recordManualActuals({ tenantId: tid, actorId: 'spoc-a', planId: planA, asOfDate: '2026-10-05', priorYearRevenueCr: '8', netNewRevenueCr: '6', blendedMarginPct: '0.2' });
      const stillComputed = (await latestActualsForPlans(tid, [{ id: planA, actualsSource: 'computed' }])).get(planA);
      check('db: a manual entry does not displace computed actuals while the plan reads computed', stillComputed?.source === 'computed');
      const rowA = await getPlanRow(tid, planA);
      const sw = await updatePlan({ tenantId: tid, actorId: 'admin-1', planId: planA, expectedVersion: rowA!.version, patch: { actualsSource: 'manual' } });
      check('db: switching the actuals source is a versioned change', sw.ok && sw.value.changed);
      const nowManual = (await latestActualsForPlans(tid, [{ id: planA, actualsSource: 'manual' }])).get(planA);
      check('db: after the switch the manual figure is the one read', nowManual?.source === 'manual' && Number(nowManual.priorYearRevenueCr) === 8);

      /* ---- versioning ---- */
      const stale = await updatePlan({ tenantId: tid, actorId: 'admin-2', planId: planA, expectedVersion: 1, patch: { terms: { ...terms, slab2RateL: '3' } } });
      check('db: an edit against a stale version is refused, not overwritten', !stale.ok && stale.conflict === true);
      const cur = await getPlanRow(tid, planA);
      const edit = await updatePlan({ tenantId: tid, actorId: 'admin-2', planId: planA, expectedVersion: cur!.version, patch: { terms: { ...terms, slab2RateL: '3' } } });
      check('db: an edit at the current version bumps the version', edit.ok && edit.value.version === cur!.version + 1);
      const versions = await listVersions(tid, planA);
      const top = versions[0]!;
      check(
        'db: the edit is attributed, timestamped and diffed in the audit trail',
        // Field-wise, not JSON.stringify: jsonb does not preserve key order.
        top.changedBy === 'admin-2' &&
          !!top.changedAt &&
          top.changes.slab2RateL?.from === '2' &&
          top.changes.slab2RateL?.to === '3',
        JSON.stringify(top),
      );
      check('db: version 1 (created) is still readable after edits', versions.some((v) => v.version === 1 && v.action === 'created'));
      let immutable = false;
      try {
        await tenantTransaction((tx) => tx.execute(sql`UPDATE incentive_plan_versions SET note = 'x' WHERE plan_id = ${planA}::uuid`));
      } catch {
        immutable = true;
      }
      check('db: the audit trail rejects UPDATE (loudly, not as a silent 0-row no-op)', immutable);
      let undeletable = false;
      try {
        await tenantTransaction((tx) => tx.execute(sql`DELETE FROM incentive_plan_versions WHERE plan_id = ${planA}::uuid`));
      } catch {
        undeletable = true;
      }
      check('db: the audit trail rejects DELETE', undeletable);
      let plansUndeletable = false;
      try {
        await tenantTransaction((tx) => tx.execute(sql`DELETE FROM incentive_plans WHERE id = ${planA}::uuid`));
      } catch {
        plansUndeletable = true;
      }
      check('db: the app cannot delete a plan (close it instead)', plansUndeletable);

      /* ---- bulk ---- */
      const bulk = await applyBulkChangeToPlans({ tenantId: tid, actorId: 'admin-1', planIds: [planA, planB], change: { slab1RateL: '1.25' } });
      check('db: bulk change applies to every selected plan', bulk.ok && bulk.value.updated === 2);
      const bv = await listVersions(tid, planB);
      check('db: bulk change is versioned per plan', bv[0]?.action === 'bulk_updated');
    });

    /* ---- tenant isolation ---- */
    const planIdA = ((await db.execute(sql`SELECT id FROM incentive_plans WHERE tenant_id = ${tid}::uuid LIMIT 1`)) as unknown as Array<{ id: string }>)[0]!.id;
    const crossTenant = await runWithSystemContext(tidB, () =>
      loadPlanForViewer(tidB, { userId: 'admin-b', role: 'admin' }, planIdA, 1),
    );
    check('db: an admin of another tenant cannot read this tenant’s plan', crossTenant === null);
    const leaked = await runWithSystemContext(tidB, () =>
      tenantTransaction((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM incentive_plans`)),
    );
    check('db: RLS hides other tenants’ plans even from a raw query', (leaked as unknown as Array<{ n: number }>)[0]?.n === 0);
  } finally {
    try {
      await db.execute(sql`DELETE FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`);
    } catch (err) {
      console.error(`WARNING: could not remove fixture tenants — delete ${SLUG_A}/${SLUG_B} by hand. ${String(err)}`);
    }
    await client.end({ timeout: 5 });
  }
}
