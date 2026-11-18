import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Load-test seed for the manager reports: one throwaway tenant with
 * 40 reps (4 managers × 9 reps, reporting lines set), 500k leads,
 * 2M activities, 300k calls (if the telephony `calls` table exists),
 * ~400k lead assignments, and stage moves through the funnel.
 *
 * NEVER run against production. Refuses unless ALLOW_LOAD_SEED=1.
 *
 *   ALLOW_LOAD_SEED=1 tsx scripts/seed-report-load.ts [--leads=500000]
 *   ALLOW_LOAD_SEED=1 tsx scripts/seed-report-load.ts --drop
 */
const SLUG = 'zz-report-load';

async function main() {
  if (process.env.ALLOW_LOAD_SEED !== '1') {
    console.error('Refusing: set ALLOW_LOAD_SEED=1 and point DATABASE_URL at a non-production database.');
    process.exit(2);
  }
  const { db, client } = await import('../src/db/index');
  const arg = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
  const LEADS = arg('leads', 500_000);
  const ACTIVITIES = arg('activities', 2_000_000);
  const CALLS = arg('calls', 300_000);
  const BATCH = 50_000;
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
  if (process.argv.includes('--drop')) {
    log('dropped');
    await client.end();
    return;
  }
  const [t] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Report load test', ${SLUG}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const T = t!.id;
  await db.execute(sql`INSERT INTO organization_settings (tenant_id, timezone) VALUES (${T}::uuid, 'Asia/Kolkata') ON CONFLICT (tenant_id) DO NOTHING`);

  // 4 managers + 36 reps; reps i report to manager (i % 4).
  await db.execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role, reports_to_user_id)
    SELECT ${T}::uuid, 'load-mgr-' || g, 'manager', NULL FROM generate_series(0, 3) g
    UNION ALL
    SELECT ${T}::uuid, 'load-rep-' || g, 'member', 'load-mgr-' || (g % 4) FROM generate_series(0, 35) g`);
  await db.execute(sql`
    INSERT INTO lead_sources (tenant_id, name, type, secret_token)
    SELECT ${T}::uuid, s, 'webhook', md5(random()::text) FROM unnest(ARRAY['Website', 'IndiaMART', 'Meta Ads', 'Referral', 'Trade show']) s`);
  log('members + sources');

  for (let off = 0; off < LEADS; off += BATCH) {
    const n = Math.min(BATCH, LEADS - off);
    await db.execute(sql`
      INSERT INTO deals (tenant_id, name, owner_id, lead_source_id, created_at, stage, amount_minor, currency, expected_close_date)
      SELECT ${T}::uuid, 'Load lead ' || (${off} + g),
             CASE WHEN g % 50 = 0 THEN NULL ELSE 'load-rep-' || (g % 36) END,
             (SELECT array_agg(id ORDER BY id) FROM lead_sources WHERE tenant_id = ${T}::uuid)[1 + g % 5],
             now() - (random() * interval '400 days'),
             'lead', (random() * 5000000)::bigint, 'INR', (now() + random() * interval '90 days')::date
      FROM generate_series(1, ${n}) g`);
    log(`leads ${off + n}/${LEADS}`);
  }
  // Funnel: move shares of leads forward (fires the stage-history trigger).
  for (const [stage, pct] of [['qualified', 45], ['proposal', 25], ['negotiation', 12]] as const) {
    await db.execute(sql`UPDATE deals SET stage = ${stage} WHERE tenant_id = ${T}::uuid AND abs(hashtext(id::text)) % 100 < ${pct}`);
    log(`stage ${stage}`);
  }
  await db.execute(sql`UPDATE deals SET stage = 'won', closed_at = created_at + random() * interval '60 days' WHERE tenant_id = ${T}::uuid AND stage = 'negotiation' AND abs(hashtext(id::text || 'w')) % 100 < 55`);
  await db.execute(sql`UPDATE deals SET stage = 'lost', closed_at = created_at + random() * interval '60 days', lost_reason = 'load test' WHERE tenant_id = ${T}::uuid AND stage IN ('lead', 'qualified') AND abs(hashtext(id::text || 'l')) % 100 < 20`);
  log('won/lost');

  await db.execute(sql`
    INSERT INTO lead_assignments (tenant_id, deal_id, assigned_to, assigned_by, assigned_at, sla_due_at, first_touch_at, released_at)
    SELECT d.tenant_id, d.id, d.owner_id, 'load', d.created_at, d.created_at + interval '30 minutes',
           CASE WHEN random() < 0.85 THEN d.created_at + random() * interval '60 minutes' END,
           CASE WHEN d.stage <> 'lead' THEN d.created_at + interval '1 day' END
    FROM deals d WHERE d.tenant_id = ${T}::uuid AND d.owner_id IS NOT NULL AND abs(hashtext(d.id::text || 'a')) % 100 < 80`);
  log('assignments');

  await db.execute(sql`DROP TABLE IF EXISTS load_deal_ids`);
  await db.execute(sql`CREATE UNLOGGED TABLE load_deal_ids AS SELECT id, row_number() OVER (ORDER BY id) AS rn FROM deals WHERE tenant_id = ${T}::uuid`);
  await db.execute(sql`CREATE INDEX ON load_deal_ids (rn)`);
  for (let off = 0; off < ACTIVITIES; off += BATCH * 4) {
    const n = Math.min(BATCH * 4, ACTIVITIES - off);
    await db.execute(sql`
      INSERT INTO activity_logs (tenant_id, actor_user_id, entity_type, entity_id, action, metadata, created_at)
      SELECT ${T}::uuid, 'load-rep-' || (g % 36), 'deal', d.id::text,
             (ARRAY['call_logged', 'meeting_logged', 'updated', 'email_sent'])[1 + g % 4], '{}'::jsonb,
             now() - (random() * interval '400 days')
      FROM generate_series(1, ${n}) g
      JOIN load_deal_ids d ON d.rn = 1 + (g % ${LEADS})`);
    log(`activities ${off + n}/${ACTIVITIES}`);
  }

  await db.execute(sql`DROP TABLE IF EXISTS load_deal_ids`);
  const hasCalls = ((await db.execute(sql`select to_regclass('public.calls') is not null as ok`)) as unknown as Array<{ ok: boolean }>)[0]?.ok;
  if (hasCalls) {
    for (let off = 0; off < CALLS; off += BATCH) {
      const n = Math.min(BATCH, CALLS - off);
      await db.execute(sql`
        INSERT INTO calls (tenant_id, provider, provider_call_id, direction, user_id, from_number, to_number, status, started_at, answered_at, talk_time_sec)
        SELECT ${T}::uuid, 'mock', 'load-' || (${off} + g), 'outbound', 'load-rep-' || (g % 36), '+910000000000', '+919800000000',
               CASE WHEN g % 5 < 2 THEN 'completed' ELSE 'no_answer' END,
               ts, CASE WHEN g % 5 < 2 THEN ts + interval '10 seconds' END, CASE WHEN g % 5 < 2 THEN 30 + (g % 600) END
        FROM (SELECT g, now() - (random() * interval '400 days') AS ts FROM generate_series(1, ${n}) g) x`);
      log(`calls ${off + n}/${CALLS}`);
    }
  } else log('calls table not present — skipped');

  await db.execute(sql`ANALYZE deals; ANALYZE activity_logs; ANALYZE lead_assignments; ANALYZE deal_stage_history`);
  log(`done. tenant ${T} (slug ${SLUG}). Next: run the rollup backfill, then scripts/loadtest-reports.ts`);
  await client.end({ timeout: 5 });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
