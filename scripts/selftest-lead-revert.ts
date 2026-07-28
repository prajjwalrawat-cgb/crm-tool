import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for the TEMPORARY bulk "Qualified → Lead" revert used to
 * undo the Lead close-date rollout. Verifies: a dated Qualified deal comes back
 * to Lead with its close date cleared, a deal in any other stage is skipped, and
 * a sales persona can't revert someone else's deal. Delete alongside
 * `src/lib/deals/revert-to-lead.ts` once the backlog is cleared.
 */
type TenantRow = { id: string };
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { deals } = await import('../src/db/schema');
  const { revertDealToLead } = await import('../src/lib/deals/revert-to-lead');

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(
        sql`select set_config('app.user_id', 'selftest-lead-revert', true)`,
      );
      return fn(tx);
    });
  }

  const rows = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as TenantRow[];
  if (rows.length === 0) {
    console.error('No tenants.');
    process.exit(2);
  }
  const tenantId = rows[0]!.id;
  console.log(`tenant=${tenantId}`);

  const OWNER = 'lead-revert-owner-selftest';
  const OTHER = 'lead-revert-other-selftest';
  const made: string[] = [];

  async function seed(stage: 'qualified' | 'proposal', ownerId: string) {
    return txAs(tenantId, async (tx) => {
      const [row] = await tx
        .insert(deals)
        .values({
          tenantId,
          name: `revert-selftest ${stage} ${ownerId}`,
          stage,
          amountMinor: 100_000,
          currency: 'INR',
          expectedCloseDate: '2026-12-31',
          ownerId,
        })
        .returning({ id: deals.id });
      made.push(row!.id);
      return row!.id;
    });
  }

  try {
    const qualifiedId = await seed('qualified', OWNER);
    const proposalId = await seed('proposal', OWNER);
    const otherOwnerId = await seed('qualified', OTHER);

    // 1. The happy path: Qualified + dated → Lead, date cleared.
    const outcome = await txAs(tenantId, (tx) =>
      revertDealToLead(tx, {
        tenantId,
        actorUserId: OWNER,
        dealId: qualifiedId,
      }),
    );
    check('qualified deal reverts', outcome === 'moved', String(outcome));

    const after = await txAs(tenantId, async (tx) => {
      const [r] = await tx
        .select({
          stage: deals.stage,
          ecd: deals.expectedCloseDate,
          fc: deals.forecastCategory,
        })
        .from(deals)
        .where(and(eq(deals.id, qualifiedId), eq(deals.tenantId, tenantId)));
      return r!;
    });
    check('lands in lead', after.stage === 'lead', after.stage);
    check('close date cleared', after.ecd === null, String(after.ecd));
    // Lead and Qualified both derive to 'pipeline', so the revert leaves the
    // category where it was — the assertion guards against it going stale.
    check('forecast category re-derived', after.fc === 'pipeline', String(after.fc));

    // 2. Only Qualified is in scope — a Proposal deal must be left alone.
    const proposalOutcome = await txAs(tenantId, (tx) =>
      revertDealToLead(tx, {
        tenantId,
        actorUserId: OWNER,
        dealId: proposalId,
      }),
    );
    check(
      'non-qualified stage skipped',
      proposalOutcome === 'skipped',
      String(proposalOutcome),
    );
    const proposalAfter = await txAs(tenantId, async (tx) => {
      const [r] = await tx
        .select({ stage: deals.stage, ecd: deals.expectedCloseDate })
        .from(deals)
        .where(and(eq(deals.id, proposalId), eq(deals.tenantId, tenantId)));
      return r!;
    });
    check(
      'skipped deal untouched',
      proposalAfter.stage === 'proposal' && proposalAfter.ecd === '2026-12-31',
      `${proposalAfter.stage}/${proposalAfter.ecd}`,
    );

    // 3. A sales persona can't revert a teammate's deal.
    const foreign = await txAs(tenantId, (tx) =>
      revertDealToLead(tx, {
        tenantId,
        actorUserId: OWNER,
        dealId: otherOwnerId,
        restrictToOwnerUserId: OWNER,
      }),
    );
    check(
      "another rep's deal skipped under owner restriction",
      foreign === 'skipped',
      String(foreign),
    );

    // 4. Re-running the revert is a no-op (the deal is in Lead now).
    const repeat = await txAs(tenantId, (tx) =>
      revertDealToLead(tx, {
        tenantId,
        actorUserId: OWNER,
        dealId: qualifiedId,
      }),
    );
    check('second revert is a no-op', repeat === 'skipped', String(repeat));
  } finally {
    for (const id of made) {
      await txAs(tenantId, (tx) =>
        tx.delete(deals).where(and(eq(deals.id, id), eq(deals.tenantId, tenantId))),
      );
    }
    await client.end();
  }

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
