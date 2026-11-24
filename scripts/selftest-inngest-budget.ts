/**
 * Self-test for the Inngest execution-budget changes. No database.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-inngest-budget.ts
 *
 * 1. eachTenant: per-tenant isolation inside a single Inngest step.
 * 2. Schedules: the high-frequency crons stay at their budgeted intervals,
 *    read from source so an accidental revert to `* * * * *` fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// each-tenant -> observability -> db-context -> db, which demands a URL at
// import. postgres.js connects lazily and nothing here queries, so a
// placeholder that is never dialled keeps this test database-free.
process.env.DATABASE_URL ??= 'postgres://selftest@127.0.0.1:1/never-connected';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}
const eq = (name: string, a: unknown, e: unknown) => check(name, JSON.stringify(a) === JSON.stringify(e), { actual: a, expected: e });

async function main() {
  const { eachTenant } = await import('../src/lib/inngest/workflows/each-tenant');

  // --- eachTenant -----------------------------------------------------------
  {
    const seen: string[] = [];
    const errors: Array<{ tenantId: string; message: string }> = [];
    const r = await eachTenant(
      ['a', 'b', 'c'],
      'test',
      async (id) => {
        seen.push(id);
        if (id === 'b') throw new Error('boom');
        return { n: id.charCodeAt(0) };
      },
      (err, tenantId) => errors.push({ tenantId, message: (err as Error).message }),
    );
    eq('eachTenant: every tenant attempted, in order, despite a failure', seen, ['a', 'b', 'c']);
    eq('eachTenant: successes keyed by tenant', r.ok, { a: { n: 97 }, c: { n: 99 } });
    eq('eachTenant: failed tenants listed', r.failed, ['b']);
    eq('eachTenant: failure reported once with tenant id', errors, [{ tenantId: 'b', message: 'boom' }]);
  }
  {
    const r = await eachTenant([], 'test', async () => 1, () => {});
    eq('eachTenant: no tenants -> empty result', r, { ok: {}, failed: [] });
  }

  // --- schedules ------------------------------------------------------------
  const wf = (f: string) => readFileSync(join(__dirname, '..', 'src', 'lib', 'inngest', 'workflows', f), 'utf8');
  /** Cron string of the createFunction block whose id is `id`. */
  const cronOf = (src: string, id: string) => {
    const at = src.indexOf(`id: '${id}'`);
    if (at < 0) return null;
    const next = src.indexOf('createFunction(', at);
    return /cron\('([^']+)'\)/.exec(src.slice(at, next < 0 ? undefined : next))?.[1] ?? null;
  };
  const telephony = wf('telephony.ts');
  const leads = wf('lead-capture.ts');
  const reports = wf('reports.ts');
  const gmail = wf('gmail-sync.ts');
  eq('cron: dialer tick every 15 min', cronOf(telephony, 'campaign-dialer-tick'), '*/15 * * * *');
  eq('cron: SLA watchdog every 10 min', cronOf(leads, 'lead-sla-watchdog'), '*/10 * * * *');
  eq('cron: unassigned retry every 15 min', cronOf(leads, 'lead-unassigned-retry'), '*/15 * * * *');
  eq('cron: report rollup every 15 min', cronOf(reports, 'report-rollup-recent'), '*/15 * * * *');
  eq('cron: gmail sync every 15 min', /cron\('([^']+)'\)/.exec(gmail)?.[1], '*/15 * * * *');

  // No per-tenant step ids left in the merged crons (each would bill one execution per tenant per run).
  check('dialer: no per-tenant steps', !/step\.run\(`(running|tick)-\$\{/.test(telephony));
  check('lead crons: no per-tenant steps', !/step\.run\(`(watchdog|retry)-\$\{/.test(leads));
  check('report rollup: no per-tenant steps', !/step\.run\(`recent-\$\{/.test(reports));
  check('gmail: no per-tenant connection-list steps', !/step\.run\(\s*`connections-\$\{/.test(gmail));

  console.log(`inngest-budget selftest: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
