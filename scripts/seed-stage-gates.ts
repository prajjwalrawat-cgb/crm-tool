import { config } from 'dotenv';
import { and, eq, ilike, or, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Seed Module 1 defaults for the CGB workspace:
 *   1. Turn ON all five Phase-2 feature flags in `workspace_settings`.
 *   2. Insert the default stage gates (Qualified / Proposal / Negotiation).
 *
 * Every other tenant is left dark (flags default OFF, no gates) per the spec:
 * "all defaulting ON for the CGB workspace, OFF for others."
 *
 * CGB is identified by tenant name (ILIKE '%CGB%') OR an explicit id passed as
 * `--tenant=<uuid>`. Runs as the migration DB role (bypasses RLS) so it can
 * write across the matched tenants in one pass. Idempotent: re-running upserts.
 *
 *   pnpm tsx scripts/seed-stage-gates.ts               # all tenants named *CGB*
 *   pnpm tsx scripts/seed-stage-gates.ts --tenant=<id> # a specific workspace
 */

type GateDefault = {
  stage: string;
  ruleType: string;
  ruleConfig: Record<string, unknown>;
  severity: 'block' | 'warn';
};

const GATE_DEFAULTS: GateDefault[] = [
  { stage: 'qualified', ruleType: 'amount_required', ruleConfig: { min: 1 }, severity: 'block' },
  {
    stage: 'proposal',
    ruleType: 'field_required',
    ruleConfig: { fields: ['contact_id'] },
    severity: 'block',
  },
  {
    stage: 'proposal',
    ruleType: 'min_activities',
    ruleConfig: { count: 1, types: ['email', 'call', 'meeting'] },
    severity: 'warn',
  },
  {
    stage: 'negotiation',
    ruleType: 'min_stakeholders',
    ruleConfig: { count: 1 },
    severity: 'block',
  },
  {
    stage: 'negotiation',
    ruleType: 'field_required',
    ruleConfig: { fields: ['competitor', 'next_step'] },
    severity: 'warn',
  },
];

async function main() {
  const { db, client } = await import('../src/db/index');
  const { tenants, workspaceSettings, stageGates } = await import(
    '../src/db/schema'
  );

  const tenantArg = process.argv
    .find((a) => a.startsWith('--tenant='))
    ?.split('=')[1];

  const matched = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(
      tenantArg
        ? eq(tenants.id, tenantArg)
        : or(ilike(tenants.name, '%CGB%'), ilike(tenants.slug, '%cgb%')),
    );

  if (matched.length === 0) {
    console.log(
      'No CGB workspace matched. Pass --tenant=<uuid> to target one explicitly.',
    );
    await client.end({ timeout: 5 });
    return;
  }

  for (const t of matched) {
    console.log(`Seeding stage gates for "${t.name}" (${t.id})...`);

    // 1. Flags ON.
    await db
      .insert(workspaceSettings)
      .values({
        tenantId: t.id,
        stageGatesEnabled: true,
        dealScoringEnabled: true,
        emailSyncEnabled: true,
        forecastsEnabled: true,
        dedupEnabled: true,
      })
      .onConflictDoUpdate({
        target: workspaceSettings.tenantId,
        set: {
          stageGatesEnabled: true,
          dealScoringEnabled: true,
          emailSyncEnabled: true,
          forecastsEnabled: true,
          dedupEnabled: true,
          updatedAt: new Date(),
        },
      });

    // 2. Default gates.
    for (const g of GATE_DEFAULTS) {
      await db
        .insert(stageGates)
        .values({
          tenantId: t.id,
          stage: g.stage as never,
          ruleType: g.ruleType,
          ruleConfig: g.ruleConfig,
          severity: g.severity,
          isActive: true,
          createdBy: 'system',
        })
        .onConflictDoUpdate({
          target: [stageGates.tenantId, stageGates.stage, stageGates.ruleType],
          set: {
            ruleConfig: g.ruleConfig,
            severity: g.severity,
            isActive: true,
            updatedAt: new Date(),
          },
        });
    }
    console.log(
      `  ✓ 5 flags ON, ${GATE_DEFAULTS.length} gates seeded for "${t.name}".`,
    );
  }

  // Sanity read-back.
  const count = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stageGates)
    .where(
      and(
        eq(stageGates.tenantId, matched[0]!.id),
        eq(stageGates.isActive, true),
      ),
    );
  console.log(`done. active gates for first tenant: ${count[0]?.n ?? 0}`);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('seed fatal:', err);
  process.exit(1);
});
