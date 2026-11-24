import { config } from 'dotenv';

config({ path: '.env.local' });
config();

/**
 * Find (and with --apply, finish) lead-capture work that never ran because
 * Inngest stopped starting functions (e.g. the plan's execution limit was hit).
 * Inngest accepted the events but never ran them, so the CRM was left with:
 *
 *   1. CSV import jobs stuck in 'queued' / 'running'
 *   2. Inbound leads (web forms, Meta, ingest API) stuck in lead_ingest_events
 *      with status 'received': the payload was saved but no lead was created
 *   3. Leads created but never distributed: stage 'lead', routing 'pending'.
 *      The unassigned-retry cron only looks back 6 hours, so older ones are
 *      never picked up again on their own.
 *
 * Everything runs in this process with the same code the workflows use, NOT via
 * Inngest, so it works while Inngest is still paused. Every step is idempotent
 * (processed events, finished jobs and assigned leads are skipped), so a re-run
 * is safe. Rows newer than --older-than-minutes are left alone as in-flight.
 *
 *   pnpm leads:recover-stuck                      # dry run: report only
 *   pnpm leads:recover-stuck --apply              # process everything found
 *   pnpm leads:recover-stuck --tenant <uuid>      # one workspace
 *   pnpm leads:recover-stuck --older-than-minutes 30 --limit 200
 *
 * Database: loads .env.local, then .env, and never overrides a variable already
 * set. To target production from a machine whose .env.local points at a test
 * DB, set DATABASE_URL explicitly for the run. The target host is printed first.
 *
 * Not recoverable here: telephony webhooks (the payload is not stored; call
 * status/recordings must be re-pulled from the provider), deal won/lost
 * follow-ups, embeddings and prospect enrichment. Nightly jobs (scores, risk,
 * reports) catch up on their own on their next run.
 */

type Args = { apply: boolean; tenant: string | null; olderThanMinutes: number; limit: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, tenant: null, olderThanMinutes: 15, limit: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--apply') out.apply = true;
    else if (a === '--tenant') out.tenant = val();
    else if (a === '--older-than-minutes') out.olderThanMinutes = Number(val());
    else if (a === '--limit') out.limit = Number(val());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.tenant && !UUID_RE.test(out.tenant)) throw new Error('--tenant must be a workspace uuid');
  if (!Number.isInteger(out.olderThanMinutes) || out.olderThanMinutes < 5) throw new Error('--older-than-minutes must be an integer >= 5');
  if (!Number.isInteger(out.limit) || out.limit < 1) throw new Error('--limit must be a positive integer');
  return out;
}

function describeTarget(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`database: ${describeTarget(process.env.DATABASE_URL)}`);
  console.log(`mode:     ${args.apply ? 'APPLY (will create and assign leads)' : 'dry run (no changes)'}`);
  console.log(`cutoff:   rows older than ${args.olderThanMinutes} min, up to ${args.limit} per category per workspace\n`);

  const { sql } = await import('drizzle-orm');
  const { db, client } = await import('../src/db/index');
  const { tenants } = await import('../src/db/schema');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const { processIngestEvent } = await import('../src/lib/lead-capture/ingest');
  const { processImportChunk } = await import('../src/lib/lead-capture/import');
  const { previousAssignees } = await import('../src/lib/lead-capture/distribute');
  const { leadDistributeHandler } = await import('../src/lib/inngest/workflows/lead-capture');
  const { localStep } = await import('../src/lib/inngest/local-step');

  const cutoff = sql`now() - make_interval(mins => ${args.olderThanMinutes})`;
  const allTenants = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
  const targets = args.tenant ? allTenants.filter((t) => t.id === args.tenant) : allTenants;
  if (args.tenant && targets.length === 0) throw new Error(`workspace ${args.tenant} not found`);

  const totals = { imports: 0, events: 0, pending: 0, created: 0, duplicate: 0, failed: 0, assigned: 0, unassigned: 0, queued: 0, skipped: 0, errors: 0 };

  for (const t of targets) {
    await runWithSystemContext(t.id, async () => {
      const stuckImports = await tenantTransaction((tx) =>
        tx.execute<{ id: string; status: string; processed: number; total: number; created_at: string }>(sql`
          select id, status, processed, total, created_at from lead_import_jobs
          where tenant_id = ${t.id} and status in ('queued', 'running') and created_at < ${cutoff}
          order by created_at limit ${args.limit}`),
      );
      const stuckEvents = await tenantTransaction((tx) =>
        tx.execute<{ id: string; received_at: string }>(sql`
          select id, received_at from lead_ingest_events
          where tenant_id = ${t.id} and status = 'received' and received_at < ${cutoff}
          order by received_at limit ${args.limit}`),
      );
      const listPending = () =>
        tenantTransaction((tx) =>
          tx.execute<{ id: string; name: string; queued_at: string }>(sql`
            select id, name, coalesce(routing_queued_at, created_at) as queued_at from deals
            where tenant_id = ${t.id} and stage = 'lead' and routing_status = 'pending' and deleted_at is null
              and coalesce(routing_queued_at, created_at) < ${cutoff}
            order by queued_at limit ${args.limit}`),
        );
      const pendingBefore = await listPending();

      if (stuckImports.length + stuckEvents.length + pendingBefore.length === 0) return;
      console.log(`== ${t.name} (${t.id})`);
      console.log(`   CSV imports stuck:        ${stuckImports.length}`);
      for (const j of stuckImports) console.log(`     - job ${j.id} ${j.status} ${j.processed}/${j.total} rows, created ${j.created_at}`);
      console.log(`   inbound leads unprocessed: ${stuckEvents.length}${stuckEvents[0] ? ` (oldest ${stuckEvents[0].received_at})` : ''}`);
      console.log(`   leads never distributed:   ${pendingBefore.length}${pendingBefore[0] ? ` (oldest ${pendingBefore[0].queued_at})` : ''}`);
      totals.imports += stuckImports.length;
      totals.events += stuckEvents.length;
      totals.pending += pendingBefore.length;
      if (!args.apply) return;

      // Leads to distribute in step 3: the stuck ones plus whatever 1 and 2 create.
      const toDistribute = new Set(pendingBefore.map((d) => d.id));

      // 1. Imports. Each chunk creates its leads with routing 'pending'.
      for (const j of stuckImports) {
        try {
          // Plenty for the workflow's 10k-row cap at IMPORT_CHUNK rows per chunk.
          for (let i = 0; i < 1000; i++) {
            const r = await processImportChunk(t.id, j.id);
            for (const id of r.createdDealIds) toDistribute.add(id);
            if (r.done) break;
          }
          console.log(`     import ${j.id}: finished`);
        } catch (err) {
          totals.errors++;
          console.error(`     import ${j.id}: ERROR ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 2. Inbound payloads -> leads (or dedupe onto the existing lead).
      for (const e of stuckEvents) {
        try {
          const out = await processIngestEvent(e.id);
          if (out.status === 'created') {
            totals.created++;
            toDistribute.add(out.dealId);
          } else if (out.status === 'duplicate') {
            totals.duplicate++;
            // A reopened lost lead with no owner needs distributing; the
            // distributor skips one that is already assigned.
            if (out.reopened && !out.ownerId) toDistribute.add(out.dealId);
          }
          else if (out.status === 'failed') {
            totals.failed++;
            console.log(`     event ${e.id}: failed validation: ${out.error}`);
          }
        } catch (err) {
          totals.errors++;
          console.error(`     event ${e.id}: ERROR ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 3. Distribute. Runs the production distributor (assignment plus
      // owner/manager notifications). Previous assignees are excluded like the
      // retry cron does, so a lead the SLA watchdog took off a rep doesn't go
      // back to them.
      for (const dealId of toDistribute) {
        try {
          const exclude = await tenantTransaction((tx) => previousAssignees(tx, dealId));
          const out = await leadDistributeHandler({
            event: { data: { tenantId: t.id, dealId, excludeUserIds: exclude } },
            step: localStep,
          });
          if (out.status === 'assigned') totals.assigned++;
          else if (out.status === 'unassigned') totals.unassigned++;
          else if (out.status === 'queued') totals.queued++;
          else totals.skipped++;
        } catch (err) {
          totals.errors++;
          console.error(`     lead ${dealId}: ERROR ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  }

  console.log('\n== summary');
  console.log(`   found: ${totals.imports} stuck import job(s), ${totals.events} unprocessed inbound lead(s), ${totals.pending} undistributed lead(s)`);
  if (args.apply) {
    console.log(`   inbound: ${totals.created} created, ${totals.duplicate} merged into existing leads, ${totals.failed} failed validation`);
    console.log(`   distribution: ${totals.assigned} assigned, ${totals.unassigned} unassigned (managers notified), ${totals.queued} waiting for shift, ${totals.skipped} skipped`);
    console.log(`   errors: ${totals.errors}`);
  } else if (totals.imports + totals.events + totals.pending > 0) {
    console.log('   dry run: re-run with --apply to process these.');
  }
  await client.end({ timeout: 5 });
  if (totals.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('recover-stuck-leads fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
