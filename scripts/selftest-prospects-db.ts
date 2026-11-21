import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for the Prospect Board (0079). Two throwaway tenants,
 * deleted at the end.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospects-db.ts
 */

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, runWithTenantContext, tenantTransaction } = await import('../src/lib/db-context');

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PROS A', ${`zz-pros-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PROS B', ${`zz-pros-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const user = `usr_prostest_${stamp}`;
  const inA = <T,>(fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
    runWithSystemContext(A, () => tenantTransaction(fn as never)) as Promise<T>;

  try {
    const p = await inA(async (tx) => {
      const [row] = await tx.insert(s.prospects).values({ tenantId: A, companyName: 'Acme Test', sourceTag: 'selftest' }).returning();
      return row!;
    });
    check('schema: prospect insert defaults', p.stage === 'dump' && Array.isArray(p.clusterTags) && p.clusterTags.length === 0, { stage: p.stage, tags: p.clusterTags });

    // Each failing insert runs in its own transaction (a failed statement aborts it).
    check('schema: size_band CHECK', await throws(() => inA((tx) => tx.insert(s.prospects).values({ tenantId: A, companyName: 'X', sourceTag: 't', sizeBand: '50-100' as never }))));
    check('schema: icp_score CHECK', await throws(() => inA((tx) => tx.insert(s.prospects).values({ tenantId: A, companyName: 'X', sourceTag: 't', icpScore: 101 }))));

    const seenByB = await runWithTenantContext({ tenantId: B, userId: user }, () =>
      tenantTransaction((tx) => tx.select().from(s.prospects).where(eq(s.prospects.id, p.id))),
    );
    check('schema: RLS isolation', seenByB.length === 0, seenByB.length);

    await inA((tx) => tx.insert(s.prospectVotes).values({ tenantId: A, prospectId: p.id, userId: user, kind: 'priority' }));
    check('schema: vote PK', await throws(() => inA((tx) => tx.insert(s.prospectVotes).values({ tenantId: A, prospectId: p.id, userId: user, kind: 'priority' }))));

    check('schema: ai_suggestions accepts prospect', !(await throws(() =>
      inA((tx) => tx.insert(s.aiSuggestions).values({
        tenantId: A, entityType: 'prospect' as never, entityId: p.id, field: 'icp_score' as never,
        suggestedValue: 80, evidenceQuote: 'reason', sourceType: 'enrichment' as never, sourceId: p.id, confidence: 0.5, model: 'm',
      })),
    )));

    check('schema: lead_sources accepts prospect_board', !(await throws(() =>
      inA((tx) => tx.insert(s.leadSources).values({ tenantId: A, name: 'Prospect Board', type: 'prospect_board' as never, secretToken: 'x'.repeat(64) })),
    )));

    const dealId = await inA(async (tx) => {
      const [d] = await tx.insert(s.deals).values({ tenantId: A, name: 'From prospect', sourceProspectId: p.id }).returning();
      return d!.id;
    });
    await inA((tx) => tx.delete(s.prospects).where(eq(s.prospects.id, p.id)));
    const [after] = await inA((tx) => tx.select({ sp: s.deals.sourceProspectId }).from(s.deals).where(eq(s.deals.id, dealId)));
    check('schema: deals.source_prospect_id set null on prospect hard delete', after?.sp === null, after);
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nprospects db selftest: ${passed} passed, ${results.length - passed} failed`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
