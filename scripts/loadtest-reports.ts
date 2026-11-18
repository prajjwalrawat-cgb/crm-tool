import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Load test for the manager report services against the seeded tenant
 * (scripts/seed-report-load.ts). Calls the same service functions the API
 * routes call, N times each, for an admin and a manager scope, and prints
 * p50 / p95 per endpoint. Paste the table into docs/reports.md.
 *
 *   ALLOW_LOAD_SEED=1 tsx --require ./scripts/_shim-server-only.cjs scripts/loadtest-reports.ts [--n=30] [--backfill]
 *
 * Targets: p95 < 800 ms for rollup-backed endpoints, < 300 ms leaderboard (cached).
 */
async function main() {
  if (process.env.ALLOW_LOAD_SEED !== '1') {
    console.error('Refusing: set ALLOW_LOAD_SEED=1 and point DATABASE_URL at a non-production database.');
    process.exit(2);
  }
  const N = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 30);
  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { scopeUsers } = await import('../src/lib/reports/manager/scope');
  const svc = await import('../src/lib/reports/manager/services');
  const rollup = await import('../src/lib/reports/manager/rollup');
  const { compareRange, resolveRange, localDay, addDays } = await import('../src/lib/reports/manager/time');
  const { percentile } = await import('../src/lib/reports/manager/math');

  const [t] = (await db.execute(sql`SELECT id FROM tenants WHERE slug = 'zz-report-load'`)) as unknown as Array<{ id: string }>;
  if (!t) throw new Error('Seed first: scripts/seed-report-load.ts');
  const T = t.id;
  const tz = 'Asia/Kolkata';

  if (process.argv.includes('--backfill')) {
    const today = localDay(new Date(), tz);
    const jobId = await runWithSystemContext(T, () => rollup.startBackfill({ tenantId: T, fromDay: addDays(today, -400), toDay: addDays(today, -1), startedBy: null }));
    const t0 = Date.now();
    for (;;) {
      const r = await runWithSystemContext(T, () => rollup.runBackfillChunk(T, jobId, 31));
      console.log(`backfill ${r.daysDone}/${r.daysTotal} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      if (r.done) break;
    }
  }

  const range = resolveRange({ preset: '30d', tz });
  const compare = compareRange(range, 'previous');
  const scopes = {
    admin: { userId: 'load-admin', role: 'owner' as const },
    manager: { userId: 'load-mgr-0', role: 'manager' as const },
  };
  const endpoints: Record<string, (s: Awaited<ReturnType<typeof scopeUsers>>) => Promise<unknown>> = {
    summary: (s) => svc.summary(s, range, compare),
    funnel: (s) => svc.funnel(s, range),
    'source-roi': (s) => svc.sourceRoiReport(s, range),
    'rep-productivity': (s) => svc.repProductivity(s, range),
    sla: (s) => svc.slaReport(s, range),
    leaderboard: (s) => svc.leaderboard(s, 'won_value', 'month'),
    'team-pipeline': (s) => svc.teamPipeline(s),
    'stale-leads': (s) => svc.staleLeads(s, 7),
  };
  const rows: string[] = ['| Endpoint | Scope | p50 ms | p95 ms |', '|---|---|---|---|'];
  for (const [scopeName, who] of Object.entries(scopes)) {
    await runWithSystemContext(T, async () => {
      const scope = await scopeUsers({ tenantId: T, userId: who.userId, role: who.role });
      for (const [name, fn] of Object.entries(endpoints)) {
        const times: number[] = [];
        for (let i = 0; i < N; i++) {
          const t0 = performance.now();
          await fn(scope);
          times.push(performance.now() - t0);
        }
        rows.push(`| ${name} | ${scopeName} | ${Math.round(percentile(times, 50)!)} | ${Math.round(percentile(times, 95)!)} |`);
        console.log(rows.at(-1));
      }
    });
  }
  console.log('\n' + rows.join('\n'));
  await client.end({ timeout: 5 });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
