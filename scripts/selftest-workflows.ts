import { config } from 'dotenv';
import { and, desc, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for the workflow dispatcher (the in-process fallback path).
 *
 * Verifies:
 *   - the `crm/ai.embed_entity` workflow handler runs locally when
 *     called via dispatchLocally and inserts a workflow_runs row
 *   - the run row is tenant-scoped (RLS-respecting)
 *   - the deal-won handler short-circuits when stage != 'won'
 *   - the deal-won handler with stage='won' writes celebratory + 7d
 *     follow-up activity rows (sleep is skipped in dev)
 *   - the new-member-onboarding handler writes an onboarding activity
 *
 * AI is forced into mock mode so embeddings stay deterministic and no
 * OpenAI traffic is generated.
 */

process.env.AI_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { activityLogs, companies, deals, workflowRuns } = await import('../src/db/schema');
  const { dispatchLocally, getRegisteredEventNames } = await import(
    '../src/lib/inngest/local-dispatcher'
  );
  // Importing the workflows barrel triggers handler registration.
  await import('../src/lib/inngest/workflows');

  const tenantRow = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  if (tenantRow.length === 0) {
    console.error('No tenants found — sign in via the app first.');
    process.exit(2);
  }
  const tenantId = tenantRow[0]!.id;

  /* -------- registry sanity -------- */
  const registered = getRegisteredEventNames();
  check(
    'local dispatcher has handlers for all event names',
    registered.includes('crm/ai.embed_entity') &&
      registered.includes('crm/deal.stage_changed') &&
      registered.includes('crm/member.invited'),
  );

  /* -------- regenerate-embedding handler -------- */
  // Seed a deal we can dispatch against, to give the workflow real
  // source text to embed. The deal is tagged so we can clean up later.
  const seedTag = `selftest-workflow-${Date.now()}`;
  const [seedCompany] = await db
    .insert(companies)
    .values({
      tenantId,
      name: 'Selftest Workflow Co.',
      domain: `${seedTag}.example`,
    })
    .returning({ id: companies.id });
  const [seedDeal] = await db
    .insert(deals)
    .values({
      tenantId,
      companyId: seedCompany!.id,
      name: 'Selftest Workflow Deal',
      stage: 'lead',
      amountMinor: 100_000,
      currency: 'USD',
    })
    .returning({ id: deals.id });

  // Dispatch the embed event locally.
  const beforeCount = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM workflow_runs WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'regenerate-embedding'`,
  )) as unknown as Array<{ n: number }>;
  const baseline = beforeCount[0]?.n ?? 0;

  await dispatchLocally('crm/ai.embed_entity', {
    tenantId,
    entityType: 'deal',
    entityId: seedDeal!.id,
    actorUserId: 'selftest-workflow',
    reason: 'created',
  });

  const afterCount = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM workflow_runs WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'regenerate-embedding'`,
  )) as unknown as Array<{ n: number }>;
  const newCount = afterCount[0]?.n ?? 0;
  check(
    'regenerate-embedding workflow run inserted via local dispatcher',
    newCount === baseline + 1,
    `before=${baseline} after=${newCount}`,
  );

  // Inspect the row for status correctness.
  const [latestRun] = (await db.execute(
    sql`SELECT status, error FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid
          AND workflow_id = 'regenerate-embedding'
        ORDER BY started_at DESC
        LIMIT 1`,
  )) as unknown as Array<{ status: string; error: string | null }>;
  check(
    'regenerate-embedding run completed (status=completed and no error)',
    latestRun?.status === 'completed' && !latestRun.error,
    latestRun?.error ?? undefined,
  );

  /* -------- deal-won handler skips when stage != 'won' -------- */

  const dealWonBefore = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'deal-won'`,
  )) as unknown as Array<{ n: number }>;
  const dealWonBaseline = dealWonBefore[0]?.n ?? 0;

  await dispatchLocally('crm/deal.stage_changed', {
    tenantId,
    dealId: seedDeal!.id,
    actorUserId: 'selftest-workflow',
    from: 'lead',
    to: 'qualified',
    name: 'Selftest Workflow Deal',
  });
  const dealWonAfterNonWon = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'deal-won'`,
  )) as unknown as Array<{ n: number }>;
  check(
    'deal-won handler short-circuits on non-won stages (no new run row)',
    (dealWonAfterNonWon[0]?.n ?? 0) === dealWonBaseline,
  );

  /* -------- deal-won handler runs when stage == 'won' -------- */

  await dispatchLocally('crm/deal.stage_changed', {
    tenantId,
    dealId: seedDeal!.id,
    actorUserId: 'selftest-workflow',
    from: 'negotiation',
    to: 'won',
    name: 'Selftest Workflow Deal',
  });
  const dealWonRun = (await db.execute(
    sql`SELECT status FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'deal-won'
        ORDER BY started_at DESC LIMIT 1`,
  )) as unknown as Array<{ status: string }>;
  check('deal-won run row written when stage=won', dealWonRun[0]?.status === 'completed');

  // Confirm both the celebration AND follow-up activity rows landed,
  // since step.sleep is a no-op in the local dispatcher.
  const wonActivities = (await db.execute(
    sql`SELECT metadata->>'kind' AS kind FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_id = ${seedDeal!.id}
          AND action = 'automation_note'
        ORDER BY created_at DESC LIMIT 5`,
  )) as unknown as Array<{ kind: string }>;
  check(
    'deal-won celebration activity recorded',
    wonActivities.some((a) => a.kind === 'celebration'),
  );
  check(
    'deal-won follow-up activity recorded (sleep skipped in dev fallback)',
    wonActivities.some((a) => a.kind === 'followup'),
  );

  /* -------- deal-won idempotency belt: re-fire from='won' -------- */

  await dispatchLocally('crm/deal.stage_changed', {
    tenantId,
    dealId: seedDeal!.id,
    actorUserId: 'selftest-workflow',
    from: 'won',
    to: 'won',
    name: 'Selftest Workflow Deal',
  });
  const wonDuplicate = (await db.execute(
    sql`SELECT status, metadata->>'reason' AS reason FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'deal-won'
        ORDER BY started_at DESC LIMIT 1`,
  )) as unknown as Array<{ status: string; reason: string | null }>;
  check(
    'deal-won re-fire from=won marks skipped (idempotency belt)',
    wonDuplicate[0]?.status === 'skipped' && wonDuplicate[0]?.reason === 'already_won',
  );

  /* -------- deal-lost idempotency belt: re-fire from='lost' -------- */

  // Trigger an initial lost transition so we have a baseline 'lost' state.
  await dispatchLocally('crm/deal.stage_changed', {
    tenantId,
    dealId: seedDeal!.id,
    actorUserId: 'selftest-workflow',
    from: 'negotiation',
    to: 'lost',
    name: 'Selftest Workflow Deal',
  });
  // Now re-fire from=lost.
  await dispatchLocally('crm/deal.stage_changed', {
    tenantId,
    dealId: seedDeal!.id,
    actorUserId: 'selftest-workflow',
    from: 'lost',
    to: 'lost',
    name: 'Selftest Workflow Deal',
  });
  const lostDuplicate = (await db.execute(
    sql`SELECT status, metadata->>'reason' AS reason FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'deal-lost'
        ORDER BY started_at DESC LIMIT 1`,
  )) as unknown as Array<{ status: string; reason: string | null }>;
  check(
    'deal-lost re-fire from=lost marks skipped (idempotency belt)',
    lostDuplicate[0]?.status === 'skipped' && lostDuplicate[0]?.reason === 'already_lost',
  );

  /* -------- workflow_runs retention sweep -------- */
  const { pruneTenantRetention } = await import(
    '../src/lib/inngest/workflows/workflow-runs-retention'
  );
  // Insert a 100-day-old "completed" row that should be pruned.
  await db.execute(
    sql`INSERT INTO workflow_runs (tenant_id, workflow_id, status, started_at, completed_at, metadata)
        VALUES (${tenantId}::uuid, 'selftest-old-row', 'completed',
                NOW() - INTERVAL '100 days', NOW() - INTERVAL '100 days', '{"selftest":true}'::jsonb)`,
  );
  const pruneResult = await pruneTenantRetention(tenantId);
  check(
    'retention prunes >30d completed rows (>=1 swept)',
    pruneResult.completed >= 1,
    `pruned: ${JSON.stringify(pruneResult)}`,
  );

  /* -------- new-member-onboarding handler -------- */

  const fakeInvitationId = `inv_${Date.now()}`;
  await dispatchLocally('crm/member.invited', {
    tenantId,
    email: 'selftest-onboard@example.com',
    role: 'member',
    invitationId: fakeInvitationId,
    inviterUserId: 'selftest-workflow',
  });
  const onboardingRun = (await db.execute(
    sql`SELECT status FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid AND workflow_id = 'new-member-onboarding'
        ORDER BY started_at DESC LIMIT 1`,
  )) as unknown as Array<{ status: string }>;
  check(
    'new-member-onboarding run row written',
    onboardingRun[0]?.status === 'completed',
  );

  /* -------- cleanup seed rows + run rows so reruns stay isolated -------- */

  await db.transaction(async (tx) => {
    // workflow_runs first (FK to tenants, cascade is on tenants but row-
    // level RLS doesn't matter for the postgres role).
    await tx.execute(
      sql`DELETE FROM workflow_runs WHERE tenant_id = ${tenantId}::uuid
            AND workflow_id IN ('regenerate-embedding', 'deal-won', 'new-member-onboarding')
            AND (
              metadata @> ${JSON.stringify({ entityId: seedDeal!.id })}::jsonb
              OR metadata @> ${JSON.stringify({ dealId: seedDeal!.id })}::jsonb
              OR metadata @> ${JSON.stringify({ invitationId: fakeInvitationId })}::jsonb
            )`,
    );
    await tx
      .delete(activityLogs)
      .where(
        and(
          eq(activityLogs.tenantId, tenantId),
          eq(activityLogs.entityId, seedDeal!.id),
        ),
      );
    await tx.delete(deals).where(eq(deals.id, seedDeal!.id));
    await tx.delete(companies).where(eq(companies.id, seedCompany!.id));
    // Embedding row associated with the deal.
    await tx.execute(
      sql`DELETE FROM embeddings WHERE tenant_id = ${tenantId}::uuid AND entity_id = ${seedDeal!.id}::text`,
    );
    // Drop the dummy ai_invocations rows we just produced.
    await tx.execute(
      sql`DELETE FROM ai_invocations WHERE tenant_id = ${tenantId}::uuid AND actor_user_id = 'selftest-workflow'`,
    );
    void workflowRuns; // satisfy unused-import lint when only used via raw sql
  });

  console.log('\n----- selftest-workflows results -----');
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n  ${passed}/${results.length} passed.`);

  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal error:', err);
  process.exit(1);
});
