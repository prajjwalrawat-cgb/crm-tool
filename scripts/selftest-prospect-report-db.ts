import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();
// .env.local may hold a real key: nothing here may reach Claude.
process.env.ANTHROPIC_API_KEY = '';

/**
 * DB-backed self-test for the Prospect Board report runner. Two throwaway
 * tenants, deleted at the end. Fixed timestamps so day math is exact.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospect-report-db.ts
 */

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

const DAY = 86_400_000;

async function main() {
  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { scopeUsers } = await import('../src/lib/reports/manager/scope');
  const { prospectBoardRunner } = await import('../src/lib/reports/queries/prospect-board');

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PBR A', ${`zz-pbr-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PBR B', ${`zz-pbr-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const U = (n: string) => `usr_pbr_${stamp}_${n}`;
  const [owner, mgr, rep1, rep2, bUser] = ['owner', 'mgr', 'rep1', 'rep2', 'b1'].map(U) as [string, string, string, string, string];

  const t0 = Date.parse('2026-03-10T00:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString();
  const RANGE = { from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' };

  try {
    await db.execute(sql`
      INSERT INTO memberships (tenant_id, user_id, role, reports_to_user_id) VALUES
        (${A}::uuid, ${owner}, 'owner', NULL),
        (${A}::uuid, ${mgr}, 'manager', NULL),
        (${A}::uuid, ${rep1}, 'member', ${mgr}),
        (${A}::uuid, ${rep2}, 'member', NULL),
        (${B}::uuid, ${bUser}, 'owner', NULL)`);

    const mkDeal = async (tenant: string, name: string) => {
      const [d] = (await db.execute(sql`INSERT INTO deals (tenant_id, name) VALUES (${tenant}::uuid, ${name}) RETURNING id`)) as unknown as Array<{ id: string }>;
      return d!.id;
    };
    type P = {
      tenant?: string; name: string; createdAt: string; createdBy: string | null; source: string; tags?: string[];
      stage?: string; claimedBy?: string | null; promotedBy?: string | null; promotedAt?: string | null; deal?: string | null;
      lastActivityAt?: string; deleted?: boolean;
    };
    const mkP = async (p: P) => {
      const tenant = p.tenant ?? A;
      const tags = `{${(p.tags ?? []).map((t) => `"${t}"`).join(',')}}`;
      const [r] = (await db.execute(sql`
        INSERT INTO prospects (tenant_id, company_name, source_tag, cluster_tags, stage, created_at, created_by, claimed_by,
                               promoted_by, promoted_at, promoted_deal_id, last_activity_at, deleted_at)
        VALUES (${tenant}::uuid, ${p.name}, ${p.source}, ${tags}::text[], ${p.stage ?? 'dump'}::prospect_stage,
                ${p.createdAt}::timestamptz, ${p.createdBy}, ${p.claimedBy ?? null}, ${p.promotedBy ?? null},
                ${p.promotedAt ?? null}::timestamptz, ${p.deal ?? null}::uuid,
                ${p.lastActivityAt ?? new Date().toISOString()}::timestamptz,
                ${p.deleted ? p.createdAt : null}::timestamptz)
        RETURNING id`)) as unknown as Array<{ id: string }>;
      return r!.id;
    };
    const mkH = (tenant: string, prospect: string, from: string | null, to: string, by: string, when: string) =>
      db.execute(sql`INSERT INTO prospect_stage_history (tenant_id, prospect_id, from_stage, to_stage, changed_by, changed_at)
        VALUES (${tenant}::uuid, ${prospect}::uuid, ${from}::prospect_stage, ${to}::prospect_stage, ${by}, ${when}::timestamptz)`);

    // ---- cohort (created in March 2026) ----
    const p1 = await mkP({ name: 'P1', createdAt: at(t0), createdBy: rep1, source: 'web', tags: ['a', 'b'], stage: 'ready', promotedBy: mgr, promotedAt: at(t0 + 6 * DAY), deal: await mkDeal(A, 'd1') });
    await mkP({ name: 'P2', createdAt: at(t0), createdBy: rep1, source: 'web', tags: [] });
    await mkP({ name: 'P3', createdAt: at(t0), createdBy: mgr, source: 'web', tags: ['a'], claimedBy: rep1 });
    const p4 = await mkP({ name: 'P4', createdAt: at(t0), createdBy: rep2, source: 'event', tags: ['b'], stage: 'ready', promotedBy: rep2, promotedAt: at(t0 + 6 * DAY), deal: await mkDeal(A, 'd4') });
    await mkP({ name: 'P5', createdAt: at(t0), createdBy: rep2, source: 'event', tags: [] });
    // outside the range / deleted: must not count
    await mkP({ name: 'P6', createdAt: '2026-02-10T00:00:00Z', createdBy: rep1, source: 'web' });
    await mkP({ name: 'P7', createdAt: at(t0), createdBy: rep1, source: 'web', deleted: true });

    // history: P1 dump -> researching (+2d) -> qualified (+5d), promoted +6d
    await mkH(A, p1, null, 'dump', rep1, at(t0));
    await mkH(A, p1, 'dump', 'researching', rep1, at(t0 + 2 * DAY));
    await mkH(A, p1, 'researching', 'qualified', rep1, at(t0 + 5 * DAY));
    // P4 (rep2): dump 4d, researching until promoted at +6d => 2d
    await mkH(A, p4, null, 'dump', rep2, at(t0));
    await mkH(A, p4, 'dump', 'researching', rep2, at(t0 + 4 * DAY));

    // ---- stale snapshot (threshold 22d for the default 45) ----
    const old = at(Date.now() - 30 * DAY);
    await mkP({ name: 'S1', createdAt: at(Date.now() - 40 * DAY), createdBy: rep1, source: 'x', stage: 'researching', lastActivityAt: old });
    await mkP({ name: 'S2', createdAt: at(Date.now() - 40 * DAY), createdBy: rep1, source: 'x', lastActivityAt: old, promotedBy: rep1, deal: await mkDeal(A, 'd-s2') });
    await mkP({ name: 'S3', createdAt: at(Date.now() - 40 * DAY), createdBy: rep1, source: 'x', stage: 'parked', lastActivityAt: old });
    await mkP({ name: 'S4', createdAt: at(Date.now() - 40 * DAY), createdBy: rep1, source: 'x', lastActivityAt: at(Date.now() - 5 * DAY) });
    await mkP({ name: 'S5', createdAt: at(Date.now() - 40 * DAY), createdBy: rep2, source: 'x', lastActivityAt: old });
    await mkP({ name: 'S6', createdAt: at(Date.now() - 40 * DAY), createdBy: rep2, source: 'x', claimedBy: rep1, lastActivityAt: old });

    // ---- auto-park history (prospects created before the range) ----
    const ap = async (name: string, by: string, who: string, when: string) => {
      const id = await mkP({ name, createdAt: '2026-01-05T00:00:00Z', createdBy: by, source: 'ap', stage: 'parked' });
      await mkH(A, id, 'dump', 'parked', who, when);
    };
    await ap('AP1', rep1, 'system:auto-park', '2026-03-15T00:00:00Z');
    await ap('AP2', rep1, 'system:auto-park', '2026-04-05T00:00:00Z'); // out of range
    await ap('AP3', rep2, 'system:auto-park', '2026-03-16T00:00:00Z'); // out of manager scope
    await ap('AP4', rep1, rep1, '2026-03-17T00:00:00Z'); // manual park

    // ---- tenant B: must never show up in A ----
    const pb = await mkP({ tenant: B, name: 'BP', createdAt: at(t0), createdBy: rep1, source: 'zzB', tags: ['zztag'], stage: 'parked', lastActivityAt: old });
    await mkH(B, pb, 'dump', 'parked', 'system:auto-park', '2026-03-20T00:00:00Z');

    const run = (tenant: string, userId: string, role: 'owner' | 'manager', range: unknown = RANGE) =>
      runWithSystemContext(tenant, async () => {
        const scope = await scopeUsers({ tenantId: tenant, userId, role });
        const res = await prospectBoardRunner(tenant, { range: range as never, scope }, { currentUserId: userId });
        return res.extras!;
      });

    const rep = (r: { userId: string; count: number }[], u: string) => r.find((x) => x.userId === u)?.count;
    const row = <T extends { key: string }>(rows: T[], k: string) => rows.find((x) => x.key === k);

    const own = await run(A, owner, 'owner');
    const mg = await run(A, mgr, 'manager');

    check('added: per rep and per source counts',
      rep(own.addedByRep, rep1) === 2 && rep(own.addedByRep, mgr) === 1 && rep(own.addedByRep, rep2) === 2 &&
        own.addedBySource.find((s) => s.sourceTag === 'web')?.count === 3 &&
        own.addedBySource.find((s) => s.sourceTag === 'event')?.count === 2 &&
        !own.addedBySource.some((s) => s.sourceTag === 'zzB' || s.sourceTag === 'x'),
      { r: own.addedByRep, s: own.addedBySource });

    const web = row(own.conversionBySource, 'web');
    check('conversion: by source with one promoted of three → 33.3%',
      web?.cohort === 3 && web.promoted === 1 && Math.abs((web.rate ?? 0) - 1 / 3) < 1e-9 && (((web.rate ?? 0) * 100).toFixed(1) === '33.3'), web);

    const ta2 = row(own.conversionByTag, 'a');
    const tb2 = row(own.conversionByTag, 'b');
    const tn = row(own.conversionByTag, '(no tag)');
    check('conversion: by tag counts a two-tag prospect in both, "(no tag)" bucket',
      ta2?.cohort === 2 && ta2.promoted === 1 && tb2?.cohort === 2 && tb2.promoted === 2 && tn?.cohort === 2 && tn.promoted === 0 &&
        !own.conversionByTag.some((t) => t.key === 'zztag'),
      own.conversionByTag);

    const byRep = (u: string) => own.conversionByRep.find((r) => r.userId === u);
    check('conversion: by rep uses promoted_by > claimed_by > created_by',
      byRep(mgr)?.cohort === 1 && byRep(mgr)?.promoted === 1 && byRep(rep1)?.cohort === 2 && byRep(rep1)?.promoted === 0 &&
        byRep(rep2)?.cohort === 2 && byRep(rep2)?.promoted === 1,
      own.conversionByRep);

    const dayOf = (e: typeof own, s: string) => e.daysInStage.find((d) => d.stage === s)!;
    check('days: dump 2.0, researching 3.0, qualified 1.0 (manager scope, prospect promoted at t0+6d)',
      dayOf(mg, 'dump').avgDays === 2 && dayOf(mg, 'researching').avgDays === 3 && dayOf(mg, 'qualified').avgDays === 1 &&
        dayOf(mg, 'dump').intervals === 1,
      mg.daysInStage);
    check('days: owner view averages every cohort interval',
      dayOf(own, 'dump').avgDays === 3 && dayOf(own, 'dump').intervals === 2 && dayOf(own, 'researching').avgDays === 2.5 && dayOf(own, 'qualified').avgDays === 1,
      own.daysInStage);
    check('days: stage with no intervals → null; all five stages in board order',
      dayOf(own, 'ready').avgDays === null && dayOf(own, 'ready').intervals === 0 && dayOf(own, 'parked').avgDays === null &&
        own.daysInStage.map((d) => d.stage).join() === 'dump,researching,qualified,ready,parked',
      own.daysInStage);

    check('stale: counts prospect idle 30d with auto_park_days 45 (threshold 22), excludes promoted/parked',
      own.stale.thresholdDays === 22 && own.stale.count === 3, own.stale);
    check('stale: autoParkedInRange counts system:auto-park history in range only', own.stale.autoParkedInRange === 2, own.stale);

    const empty = await run(A, owner, 'owner', { from: '2020-01-01T00:00:00Z', to: '2020-02-01T00:00:00Z' });
    check('empty range → zero counts, null rates, no NaN',
      empty.addedByRep.length === 0 && empty.addedBySource.length === 0 && empty.conversionBySource.length === 0 &&
        empty.conversionByTag.length === 0 && empty.conversionByRep.length === 0 &&
        empty.daysInStage.every((d) => d.avgDays === null && d.intervals === 0) &&
        empty.stale.autoParkedInRange === 0 && !JSON.stringify(empty).includes('NaN'),
      empty);

    const mgJson = JSON.stringify(mg);
    check('manager scope: out-of-team rep prospects absent from every section and from stale count',
      !mgJson.includes(rep2) && !mg.addedBySource.some((s) => s.sourceTag === 'event') && !mg.conversionBySource.some((s) => s.key === 'event') &&
        rep(mg.addedByRep, rep1) === 2 && rep(mg.addedByRep, mgr) === 1 &&
        mg.stale.count === 2 && mg.stale.autoParkedInRange === 1 &&
        row(mg.conversionByTag, 'b')?.cohort === 1 && row(mg.conversionByTag, '(no tag)')?.cohort === 1,
      mg);

    check('owner sees all', own.addedByRep.length === 3 && own.stale.count === 3, own.addedByRep);

    const bView = await run(B, bUser, 'owner');
    check('cross-tenant data never included',
      !JSON.stringify(own).includes('zzB') && !JSON.stringify(own).includes('zztag') && own.stale.autoParkedInRange === 2 &&
        bView.addedBySource.length === 1 && bView.addedBySource[0]!.sourceTag === 'zzB' && bView.stale.autoParkedInRange === 1 && bView.stale.count === 0,
      { own, bView });
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nprospect report db selftest: ${passed} passed, ${results.length - passed} failed`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
