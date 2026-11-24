import { execFileSync } from 'node:child_process';

import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for scripts/recover-stuck-leads.ts. Runs against
 * DATABASE_URL (use the test DB). Creates one throwaway tenant, seeds the
 * three kinds of stuck work, runs the script as a child process (dry run, then
 * --apply, then --apply again) and deletes the tenant (cascade) at the end.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-recover-stuck-leads-db.ts
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

/** Run the recovery script for one tenant; never reaches Claude, SMTP or Inngest cloud. */
function runScript(tenantId: string, ...extra: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', INNGEST_EVENT_KEY: '' };
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', '--require', './scripts/_shim-server-only.cjs', 'scripts/recover-stuck-leads.ts', '--tenant', tenantId, ...extra],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const { receiveIngestEvent, processIngestEvent } = await import('../src/lib/lead-capture/ingest');

  const stamp = Date.now();
  const [tr] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Recover Stuck', ${`zz-recover-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const T = tr!.id;
  const u1 = `usr_recover_${stamp}_u1`;
  const u2 = `usr_recover_${stamp}_u2`;
  const asT = <R>(fn: () => Promise<R>) => runWithSystemContext(T, fn);
  const q = <R>(query: ReturnType<typeof sql>) => asT(() => tenantTransaction((tx) => tx.execute(query))) as Promise<R[]>;

  try {
    const src = await asT(() =>
      tenantTransaction(async (tx) => {
        await tx.insert(s.memberships).values([
          { tenantId: T, userId: u1, role: 'member' },
          { tenantId: T, userId: u2, role: 'member' },
        ]);
        const [w] = await tx.insert(s.leadSources).values({ tenantId: T, name: 'Website', type: 'webhook', secretToken: `sec_${stamp}` }).returning();
        await tx.insert(s.distributionRules).values({ tenantId: T, name: 'RR', priority: 100, strategy: 'round_robin', pool: { user_ids: [u1, u2] }, isDefault: true, slaMinutes: 30 });
        return w!;
      }),
    );

    // 1. Inbound payload saved, never processed (old) + one in flight (fresh).
    const stuck = await receiveIngestEvent({ tenantId: T, sourceId: src.id, payload: { name: 'Stuck Inbound', mobile: '+91 90000 00001' } });
    const fresh = await receiveIngestEvent({ tenantId: T, sourceId: src.id, payload: { name: 'Fresh Inbound', mobile: '+91 90000 00002' } });
    await q(sql`update lead_ingest_events set received_at = now() - interval '2 hours' where id = ${stuck.eventId}`);

    // 2. CSV import job queued, never run.
    const [job] = await q<{ id: string }>(sql`
      insert into lead_import_jobs (tenant_id, source_id, created_by, rows, total, created_at)
      values (${T}, ${src.id}, ${u1}, ${JSON.stringify([
        { name: 'Import One', mobile: '+91 90000 00003' },
        { name: 'Import Two', mobile: '+91 90000 00004' },
      ])}::jsonb, 2, now() - interval '2 hours')
      returning id`);

    // 3. Lead created, never distributed, outside the retry cron's 6h window.
    const oldEv = await receiveIngestEvent({ tenantId: T, sourceId: src.id, payload: { name: 'Old Pending', mobile: '+91 90000 00005' } });
    const created = await asT(() => processIngestEvent(oldEv.eventId));
    const oldPendingId = created.status === 'created' ? created.dealId : '';
    check('fixture: pending lead created', !!oldPendingId, created);
    await q(sql`update deals set routing_queued_at = now() - interval '8 hours' where id = ${oldPendingId}`);

    // ---- dry run changes nothing
    const dry = runScript(T);
    check('dry run reports 1 import, 1 inbound, 1 undistributed',
      /CSV imports stuck:\s+1/.test(dry) && /inbound leads unprocessed:\s+1\b/.test(dry) && /leads never distributed:\s+1\b/.test(dry), dry);
    const [afterDry] = await q<{ n: number }>(sql`select count(*)::int as n from lead_ingest_events where tenant_id = ${T} and status = 'received'`);
    check('dry run left both events unprocessed', Number(afterDry?.n) === 2, afterDry);

    // ---- apply
    const out = runScript(T, '--apply');
    check('apply reports 1 created and 4 assigned, 0 errors',
      /inbound: 1 created/.test(out) && /distribution: 4 assigned/.test(out) && /errors: 0/.test(out), out);

    const evs = await q<{ id: string; status: string }>(sql`select id, status from lead_ingest_events where id in (${stuck.eventId}, ${fresh.eventId})`);
    const st = Object.fromEntries(evs.map((e) => [e.id, e.status]));
    check('stuck inbound event processed', st[stuck.eventId] === 'processed', st);
    check('fresh (in-flight) event untouched', st[fresh.eventId] === 'received', st);

    const [j] = await q<{ status: string; created_count: number }>(sql`select status, created_count from lead_import_jobs where id = ${job!.id}`);
    check('import job finished with 2 leads', j?.status === 'done' && Number(j.created_count) === 2, j);

    const leads = await q<{ name: string; owner_id: string | null; routing_status: string }>(sql`
      select d.name, d.owner_id, d.routing_status from deals d where d.tenant_id = ${T} order by d.name`);
    // Captured leads are named "<contact> – enquiry".
    const byName = Object.fromEntries(leads.map((l) => [l.name.split(' – ')[0], l]));
    for (const n of ['Stuck Inbound', 'Import One', 'Import Two', 'Old Pending']) {
      const l = byName[n];
      check(`${n}: assigned to a pool member`, l?.routing_status === 'assigned' && [u1, u2].includes(l.owner_id ?? ''), l ?? leads);
    }
    check('fresh inbound produced no lead yet', !byName['Fresh Inbound'], leads);

    // ---- idempotent: a second apply finds nothing older than the cutoff
    const again = runScript(T, '--apply');
    check('second apply finds nothing', /found: 0 stuck import job\(s\), 0 unprocessed inbound lead\(s\), 0 undistributed lead\(s\)/.test(again), again);

    // ---- regression: the unassigned-retry cron's query used to throw on a bound Date
    const { retryUnassignedLeads } = await import('../src/lib/lead-capture/sla');
    const recentEv = await receiveIngestEvent({ tenantId: T, sourceId: src.id, payload: { name: 'Recent Pending', mobile: '+91 90000 00006' } });
    const recent = await asT(() => processIngestEvent(recentEv.eventId));
    await q(sql`update deals set routing_queued_at = now() - interval '10 minutes' where id = ${recent.status === 'created' ? recent.dealId : ''}`);
    const retried = await asT(() => retryUnassignedLeads(T));
    check('retryUnassignedLeads runs and assigns the queued lead', retried.tried === 1 && retried.assigned === 1, retried);
  } catch (err) {
    const e = err as { message?: string; stdout?: string; stderr?: string };
    check('unexpected error', false, `${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id = ${T}`);
    await client.end({ timeout: 5 });
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${!r.ok && r.detail ? `\n     ${r.detail}` : ''}`);
  console.log(`recover-stuck-leads db selftest: ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
