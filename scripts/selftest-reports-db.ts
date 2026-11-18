import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for the manager reports (build prompt 3). Needs
 * migrations 0072 + 0074 (0073 optional — call metrics read 0 without it).
 * Creates two throwaway tenants, deletes them (cascade) at the end.
 * DO NOT point this at production.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-reports-db.ts
 *
 * Covers:
 *   - scoping matrix: every report service × {rep, manager with subtree,
 *     manager without reports (tenant fallback), owner, other tenant}
 *   - tile → drill-down reconciliation for every KPI tile
 *   - rollup backfill resumable: interrupted + resumed == clean rebuild
 *   - rollup refresh idempotent (twice == once)
 *   - digest claim idempotent (same day sends once)
 */
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
let exitCode = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { scopeUsers } = await import('../src/lib/reports/manager/scope');
  const svc = await import('../src/lib/reports/manager/services');
  const rollup = await import('../src/lib/reports/manager/rollup');
  const { claimDigest } = await import('../src/lib/reports/manager/digest');
  const { resolveRange, compareRange, localDay, addDays } = await import('../src/lib/reports/manager/time');

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Reports A', ${`zz-rep-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Reports B', ${`zz-rep-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const U = (n: string) => `usr_reptest_${stamp}_${n}`;
  const [owner, mgr, mgr2, r1, r2, r3, bUser] = ['owner', 'mgr', 'mgr2', 'r1', 'r2', 'r3', 'b1'].map(U) as [string, string, string, string, string, string, string];
  const tz = 'Asia/Kolkata';

  try {
    // Fixture as table owner (maintenance-script privileges), then read through RLS.
    await db.execute(sql`INSERT INTO organization_settings (tenant_id, timezone) VALUES (${A}::uuid, ${tz}), (${B}::uuid, ${tz}) ON CONFLICT (tenant_id) DO UPDATE SET timezone = EXCLUDED.timezone`);
    await db.execute(sql`
      INSERT INTO memberships (tenant_id, user_id, role, reports_to_user_id) VALUES
        (${A}::uuid, ${owner}, 'owner', NULL),
        (${A}::uuid, ${mgr}, 'manager', NULL),
        (${A}::uuid, ${mgr2}, 'manager', NULL),
        (${A}::uuid, ${r1}, 'member', ${mgr}),
        (${A}::uuid, ${r2}, 'member', ${r1}),
        (${A}::uuid, ${r3}, 'member', NULL),
        (${B}::uuid, ${bUser}, 'owner', NULL)`);
    const today = localDay(new Date(), tz);
    const at = (daysAgo: number, hh = '10:00') => `${addDays(today, -daysAgo)}T${hh}:00+05:30`;
    // 9 deals in A across owners; 1 deal in B.
    const deals: Array<[string, string, string, string, number, string | null]> = [
      // [name, owner, created, stage, amountMinor, closedAt]
      ['A-r1-1', r1, at(3), 'won', 5_000_000, at(1)],
      ['A-r1-2', r1, at(3), 'lost', 1_000_000, at(1)],
      ['A-r1-3', r1, at(2), 'proposal', 2_000_000, null],
      ['A-r2-1', r2, at(2), 'won', 3_000_000, at(0, '09:00')],
      ['A-r2-2', r2, at(1), 'lead', 500_000, null],
      ['A-r3-1', r3, at(2), 'qualified', 800_000, null],
      ['A-r3-2', r3, at(1), 'won', 1_200_000, at(0, '09:30')],
      ['A-own-1', owner, at(1), 'negotiation', 9_000_000, null],
      ['A-none-1', '', at(0, '08:00'), 'lead', 0, null],
    ];
    for (const [name, o, created, stage, amt, closed] of deals) {
      await db.execute(sql`
        INSERT INTO deals (tenant_id, name, owner_id, created_at, stage, amount_minor, currency, closed_at, expected_close_date)
        VALUES (${A}::uuid, ${name}, ${o || null}, ${created}::timestamptz, ${stage}, ${amt}, 'INR', ${closed}::timestamptz, ${today}::date)`);
    }
    await db.execute(sql`INSERT INTO deals (tenant_id, name, owner_id, created_at, stage, amount_minor, currency, closed_at, expected_close_date) VALUES (${B}::uuid, 'B-1', ${bUser}, now(), 'won', 999, 'INR', now(), ${today}::date)`);
    // Assignments for SLA: r1 met, r2 breached.
    await db.execute(sql`
      INSERT INTO lead_assignments (tenant_id, deal_id, assigned_to, assigned_by, assigned_at, sla_due_at, first_touch_at)
      SELECT ${A}::uuid, d.id, d.owner_id, 'test', d.created_at, d.created_at + interval '30 minutes',
             CASE WHEN d.owner_id = ${r1} THEN d.created_at + interval '10 minutes' ELSE NULL END
      FROM deals d WHERE d.tenant_id = ${A}::uuid AND d.owner_id IN (${r1}, ${r2})`);

    const roleOf: Record<string, 'owner' | 'manager' | 'member'> = { [owner]: 'owner', [mgr]: 'manager', [mgr2]: 'manager', [r1]: 'member', [r2]: 'member', [r3]: 'member' };
    const expectedOwners: Record<string, string[] | null> = {
      [owner]: null, // tenant
      [mgr]: [mgr, r1, r2], // subtree (r2 reports to r1 who reports to mgr)
      [mgr2]: null, // no reports → tenant fallback
      [r1]: [r1],
      [r3]: [r3],
    };

    const range = resolveRange({ preset: '7d', tz });
    const compare = compareRange(range, 'previous');

    /* ---------------- scoping matrix ---------------- */
    for (const [user, expected] of Object.entries(expectedOwners)) {
      const label = user.split('_').pop();
      await runWithSystemContext(A, async () => {
        const scope = await scopeUsers({ tenantId: A, userId: user, role: roleOf[user]! });
        check(`[${label}] scope users`, JSON.stringify(scope.userIds?.slice().sort() ?? null) === JSON.stringify(expected?.slice().sort() ?? null), { got: scope.userIds });
        const allowed = (id: string | null) => expected === null || (id !== null && expected.includes(id));
        const [rp, sla, lb, tp, st, dr, fn] = await Promise.all([
          svc.repProductivity(scope, range),
          svc.slaReport(scope, range),
          svc.leaderboard(scope, 'won_value', 'month'),
          svc.teamPipeline(scope),
          svc.staleLeads(scope, 0),
          svc.drill(scope, 'lead_volume', range),
          svc.funnelDrill(scope, range, 'lead'),
        ]);
        check(`[${label}] rep productivity owners in scope`, rp.rows.every((r) => allowed(r.userId)), rp.rows.map((r) => r.userId));
        check(`[${label}] sla by rep in scope`, sla.byRep.every((r) => allowed(r.userId)));
        check(`[${label}] leaderboard in scope`, lb.rows.every((r) => allowed(r.userId)));
        check(`[${label}] team pipeline in scope`, tp.columns.every((c) => c.reps.every((r) => allowed(r.userId))));
        check(`[${label}] stale leads in scope`, st.rows.every((r) => allowed(r.ownerId)));
        check(`[${label}] drill rows in scope`, dr.rows.every((r) => allowed((r.owner_id as string | null) ?? null)));
        check(`[${label}] funnel cohort in scope`, fn.every((r) => allowed(r.ownerId || null)));
        check(`[${label}] never sees tenant B`, !dr.rows.some((r) => String(r.name).startsWith('B-')));
        if (expected !== null) check(`[${label}] unowned rows hidden`, !dr.rows.some((r) => r.owner_id === null));
      });
    }
    await runWithSystemContext(B, async () => {
      const scope = await scopeUsers({ tenantId: B, userId: bUser, role: 'owner' });
      const dr = await svc.drill(scope, 'lead_volume', range);
      check('[tenant B] sees only its own deal', dr.count === 1 && dr.rows.every((r) => String(r.name).startsWith('B-')), dr.count);
      const crossScope = { ...scope, tenantId: A };
      const leak = await svc.drill(crossScope, 'lead_volume', range);
      check('[tenant B] forging tenant A in scope returns zero rows (RLS)', leak.count === 0, leak.count);
    });

    /* ---------------- tile ↔ drill reconciliation ---------------- */
    await runWithSystemContext(A, async () => {
      const scope = await scopeUsers({ tenantId: A, userId: owner, role: 'owner' });
      const s = await svc.summary(scope, range, compare);
      for (const t of s.tiles) {
        if (!t.drill) continue;
        const d = await svc.drill(scope, t.drill as never, range);
        let recon: number | null;
        if (t.key === 'lead_volume') recon = d.count;
        else if (t.key === 'won_value' || t.key === 'pipeline_value' || t.key === 'forecast_this_month') recon = d.sum;
        else if (t.key === 'contact_rate' || t.key === 'sla_compliance_pct') recon = d.count ? Math.round(((d.sum ?? 0) / d.count) * 1000) / 10 : null;
        else recon = null;
        check(`tile ${t.key} = drill-down`, recon === t.value, { tile: t.value, drill: recon });
      }
      const fun = await svc.funnel(scope, range);
      for (const step of fun.steps) {
        const rows = await svc.funnelDrill(scope, range, step.stage);
        check(`funnel bar ${step.stage} = drill-down`, rows.length === step.count, { bar: step.count, drill: rows.length });
      }
    });

    /* ---------------- rollup: idempotent + resumable ---------------- */
    await runWithSystemContext(A, async () => {
      const snapshot = async () =>
        JSON.stringify(
          await db.execute(sql`
            SELECT day::text, owner_id, source_id, leads_created, won_count, won_value::text, lost_count, qualified, activities
            FROM report_daily_rollup WHERE tenant_id = ${A}::uuid ORDER BY day, owner_id, source_id NULLS FIRST`),
        );
      const from = addDays(today, -6);
      await rollup.refreshRollup(A, from, today);
      const once = await snapshot();
      await rollup.refreshRollup(A, from, today);
      check('rollup refresh is idempotent', (await snapshot()) === once);

      await db.execute(sql`DELETE FROM report_daily_rollup WHERE tenant_id = ${A}::uuid`);
      const jobId = await rollup.startBackfill({ tenantId: A, fromDay: from, toDay: today, startedBy: null });
      const partial = await rollup.runBackfillChunk(A, jobId, 3); // "killed" after 3 days
      check('backfill stops mid-way', !partial.done && partial.daysDone === 3, partial);
      const resumed = await rollup.runBackfillChunk(A, jobId, 100);
      check('backfill resumes to completion', resumed.done && resumed.daysDone === 7, resumed);
      check('resumed backfill == clean rebuild', (await snapshot()) === once);

      const s = await svc.summary(await scopeUsers({ tenantId: A, userId: owner, role: 'owner' }), range, compare);
      check('summary reads rollup for past days', s.servedBy.some((x) => x.source === 'rollup'), s.servedBy);
    });

    /* ---------------- digest idempotency ---------------- */
    await runWithSystemContext(A, async () => {
      const first = await claimDigest(A, 'daily', mgr, today);
      const second = await claimDigest(A, 'daily', mgr, today);
      check('digest claimed once per (digest, user, day)', first && !second, { first, second });
    });
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  console.log('\n─── Reports DB self-test ───');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
