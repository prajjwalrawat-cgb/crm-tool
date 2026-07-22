import { config } from 'dotenv';
import { and, eq, inArray, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for Module 1 — Stage-Gate Enforcement. Drives the real
 * `evaluateStageTransition` / `checkGateAndLogWarnings` services (imported via
 * the server-only shim in the `selftest` npm script) against DB fixtures under
 * a hand-rolled tenant context, exactly like scripts/selftest-lifecycle.ts.
 *
 * To avoid clobbering a real tenant's seeded gates (which live on
 * qualified/proposal/negotiation) the fixtures gate the won/hold/lost stages
 * instead, snapshot + restore the STAGE_GATES flag, and delete every row they
 * create at the end.
 *
 * Covers ≥6 scenarios incl. edges: dead deal, perfect deal, brand-new (create)
 * deal, warn-allows-and-logs, custom-note-at-transition, flag-off bypass,
 * override merge, and determinism.
 *
 * Run: pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-stage-gates.ts
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
  const { workspaceSettings, stageGates, deals, dealContacts, activityLogs } =
    await import('../src/db/schema');
  const { evaluateStageTransition, evaluateStageGatesForDeal } = await import(
    '../src/lib/stage-gates/evaluate'
  );
  const { checkGateAndLogWarnings } = await import(
    '../src/lib/stage-gates/enforce'
  );

  async function txAs<T>(
    opts: { tenantId: string; userId: string },
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${opts.tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${opts.userId}, true)`);
      return await fn(tx);
    });
  }

  const allTenants = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as TenantRow[];
  if (allTenants.length === 0) {
    console.error('No tenants found — sign in via the app to provision one first.');
    process.exit(2);
  }
  const tenantId = allTenants[0]!.id;
  const USER = 'selftest-gates';
  console.log(`tenant=${tenantId}`);

  // Snapshot the flag so we can restore it.
  const priorFlag = await txAs({ tenantId, userId: USER }, async (tx) => {
    const rows = await tx
      .select({ enabled: workspaceSettings.stageGatesEnabled })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.tenantId, tenantId));
    return rows[0]?.enabled ?? null;
  });

  const createdGateIds: string[] = [];
  let dealId = '';

  try {
    // Enable the flag.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      await tx
        .insert(workspaceSettings)
        .values({ tenantId, stageGatesEnabled: true })
        .onConflictDoUpdate({
          target: workspaceSettings.tenantId,
          set: { stageGatesEnabled: true },
        });
    });

    // Fixture gates on non-seeded stages.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const rows = await tx
        .insert(stageGates)
        .values([
          { tenantId, stage: 'won', ruleType: 'amount_required', ruleConfig: { min: 5 }, severity: 'block', createdBy: USER },
          { tenantId, stage: 'won', ruleType: 'min_stakeholders', ruleConfig: { count: 1 }, severity: 'block', createdBy: USER },
          { tenantId, stage: 'hold', ruleType: 'field_required', ruleConfig: { fields: ['contact_id'] }, severity: 'block', createdBy: USER },
          { tenantId, stage: 'hold', ruleType: 'min_activities', ruleConfig: { count: 1, types: ['call', 'email', 'meeting'] }, severity: 'warn', createdBy: USER },
          { tenantId, stage: 'lost', ruleType: 'custom_note', ruleConfig: { prompt: 'Why lost?' }, severity: 'block', createdBy: USER },
        ])
        .returning({ id: stageGates.id });
      for (const r of rows) createdGateIds.push(r.id);
    });

    // A dead deal: amount 0, no contact, no activity.
    dealId = await txAs({ tenantId, userId: USER }, async (tx) => {
      const [row] = await tx
        .insert(deals)
        .values({ tenantId, name: 'Gate Selftest Deal', stage: 'lead', amountMinor: 0, currency: 'INR' })
        .returning({ id: deals.id });
      return row!.id;
    });

    // 1. Dead deal → won: amount_required + min_stakeholders both block.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const r = await evaluateStageTransition(tx, {
        tenantId, dealId, fromStage: 'lead', toStage: 'won',
      });
      const blocked = r.failures.filter((f) => f.severity === 'block');
      check('dead deal blocked from won', !r.allowed && blocked.length === 2,
        `allowed=${r.allowed} blockers=${blocked.length}`);
    });

    // 2. Determinism: same inputs → same result.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const a = await evaluateStageTransition(tx, { tenantId, dealId, fromStage: 'lead', toStage: 'won' });
      const b = await evaluateStageTransition(tx, { tenantId, dealId, fromStage: 'lead', toStage: 'won' });
      check('deterministic result', JSON.stringify(a) === JSON.stringify(b));
    });

    // 3. Override merge: passing a high amount satisfies amount_required
    //    without touching the DB row (still blocked only by min_stakeholders).
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const r = await evaluateStageTransition(tx, {
        tenantId, dealId, fromStage: 'lead', toStage: 'won',
        override: { amountMinor: 100000 },
      });
      const blocked = r.failures.filter((f) => f.severity === 'block');
      check('override satisfies amount rule', blocked.length === 1 && blocked[0]!.rule_type === 'min_stakeholders',
        `blockers=${blocked.map((b) => b.rule_type).join(',')}`);
    });

    // 4. Brand-new (create) deal, dealId null → won: min_stakeholders blocks
    //    even with a high override amount (no stakeholders can exist yet).
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const r = await evaluateStageTransition(tx, {
        tenantId, dealId: null, fromStage: 'lead', toStage: 'won',
        override: { amountMinor: 100000 },
      });
      check('new deal blocked by stakeholders', !r.allowed);
    });

    // 5. hold: contact missing → field_required BLOCK, min_activities WARN.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const r = await evaluateStageTransition(tx, { tenantId, dealId, fromStage: 'lead', toStage: 'hold' });
      const block = r.failures.filter((f) => f.severity === 'block');
      const warn = r.failures.filter((f) => f.severity === 'warn');
      check('hold blocked by field, warns on activity', !r.allowed && block.length === 1 && warn.length === 1,
        `block=${block.length} warn=${warn.length}`);
    });

    // 6. Satisfy the contact (override) but leave activity empty → allowed
    //    (warn does NOT block) and checkGateAndLogWarnings writes a gate_warning.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const r = await checkGateAndLogWarnings(tx, {
        tenantId, actorUserId: USER, dealId, dealName: 'Gate Selftest Deal',
        fromStage: 'lead', toStage: 'hold',
        override: { contactId: '00000000-0000-0000-0000-000000000001' },
      });
      check('warn allows the move', r.allowed);
      const warnRows = await tx
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(and(
          eq(activityLogs.tenantId, tenantId),
          eq(activityLogs.entityId, dealId),
          eq(activityLogs.action, 'gate_warning'),
        ));
      check('gate_warning activity logged', warnRows.length === 1, `rows=${warnRows.length}`);
    });

    // 7. Perfect deal for hold: contact + a logged activity → fully allowed,
    //    no failures.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      await tx.insert(activityLogs).values({
        tenantId, actorUserId: USER, entityType: 'deal', entityId: dealId, action: 'call_logged', metadata: {},
      });
      const r = await evaluateStageTransition(tx, {
        tenantId, dealId, fromStage: 'lead', toStage: 'hold',
        override: { contactId: '00000000-0000-0000-0000-000000000001' },
      });
      check('perfect deal allowed with no failures', r.allowed && r.failures.length === 0,
        `failures=${r.failures.length}`);
    });

    // 8. custom_note on lost: blocked without a note, allowed with one.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const without = await evaluateStageTransition(tx, { tenantId, dealId, fromStage: 'lead', toStage: 'lost' });
      const withNote = await evaluateStageTransition(tx, { tenantId, dealId, fromStage: 'lead', toStage: 'lost', gateNote: 'Budget cut' });
      check('custom_note blocks without note', !without.allowed);
      check('custom_note allows with note', withNote.allowed);
    });

    // 9. Path-bar read view returns per-rule satisfied flags.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      const rules = await evaluateStageGatesForDeal(tx, tenantId, dealId, 'won');
      check('path-bar rules returned', rules.length === 2 && rules.every((r) => typeof r.satisfied === 'boolean'));
    });

    // 10. Flag OFF → every transition allowed regardless of gates.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      await tx
        .update(workspaceSettings)
        .set({ stageGatesEnabled: false })
        .where(eq(workspaceSettings.tenantId, tenantId));
      const r = await evaluateStageTransition(tx, { tenantId, dealId, fromStage: 'lead', toStage: 'won' });
      check('flag off bypasses gates', r.allowed && r.failures.length === 0);
    });
  } finally {
    // Cleanup: remove fixtures, restore flag.
    await txAs({ tenantId, userId: USER }, async (tx) => {
      if (dealId) {
        await tx.delete(dealContacts).where(eq(dealContacts.dealId, dealId));
        await tx.delete(activityLogs).where(and(eq(activityLogs.tenantId, tenantId), eq(activityLogs.entityId, dealId)));
        await tx.delete(deals).where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)));
      }
      if (createdGateIds.length > 0) {
        await tx.delete(stageGates).where(and(eq(stageGates.tenantId, tenantId), inArray(stageGates.id, createdGateIds)));
      }
      if (priorFlag === null) {
        await tx.delete(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
      } else {
        await tx
          .update(workspaceSettings)
          .set({ stageGatesEnabled: priorFlag })
          .where(eq(workspaceSettings.tenantId, tenantId));
      }
    });
  }

  console.log('\n─── Stage-gate self-test ───');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
