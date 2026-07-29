/**
 * Read-only end-to-end page probe against a running server (`next start`).
 *
 * Measures what Chrome's Network panel measures, split into the two
 * numbers that matter for a streamed RSC response:
 *
 *   TTFB      — first byte of the shell (fast; the loading.tsx boundary)
 *   stream    — first byte → last byte, i.e. how long the server took to
 *               finish the real data fetch. DevTools reports this as
 *               "Content Download", which is why it looks like a transfer
 *               problem when it is actually server-side data time.
 *
 * Then it replays the sidebar's `<Link>` prefetch fan-out (the `?_rsc=`
 * requests the browser fires automatically in production) to show what
 * the page costs when it is competing with them.
 *
 *   BASE=http://localhost:3000 npx tsx --require ./scripts/_shim-server-only.cjs scripts/_perf-page.ts
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

config({ path: '.env.local' });
config();

const BASE = process.env.BASE ?? 'http://localhost:3000';
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// The routes the admin sidebar renders, i.e. what gets prefetched on
// every dashboard page load in production.
const SIDEBAR = [
  '/dashboard',
  '/dashboard/executive',
  '/dashboard/executive/forecast',
  '/dashboard/team',
  '/dashboard/activity',
  '/dashboard/deals/board',
  '/dashboard/deals',
  '/dashboard/deals/approvals',
  '/dashboard/targets',
  '/dashboard/communications',
  '/dashboard/reports',
  '/dashboard/contacts',
  '/dashboard/companies',
  '/dashboard/command-center',
  '/dashboard/intelligence',
  '/dashboard/workflows',
  '/dashboard/ops',
  '/dashboard/settings',
  '/dashboard/recently-deleted',
];

type Timing = {
  status: number;
  ttfb: number;
  stream: number;
  total: number;
  wireBytes: number;
  rawBytes: number;
  encoding: string;
};

async function fetchTimed(path: string, cookie: string, prefetch = false): Promise<Timing> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      cookie,
      'accept-encoding': 'gzip, deflate, br',
      ...(prefetch
        ? { RSC: '1', 'Next-Router-Prefetch': '1', 'Next-Url': '/dashboard' }
        : {}),
    },
  });
  const chunks: Buffer[] = [];
  let ttfb = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!ttfb) ttfb = performance.now() - t0;
    chunks.push(Buffer.from(value));
  }
  const total = performance.now() - t0;
  const wire = Buffer.concat(chunks);
  const encoding = res.headers.get('content-encoding') ?? 'identity';
  let raw = wire;
  try {
    if (encoding === 'gzip') raw = gunzipSync(wire);
    else if (encoding === 'br') raw = brotliDecompressSync(wire);
  } catch {
    /* streamed frames may not decode standalone */
  }
  return {
    status: res.status,
    ttfb,
    stream: total - ttfb,
    total,
    wireBytes: wire.byteLength,
    rawBytes: raw.byteLength,
    encoding,
  };
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { signSession } = await import('../src/lib/auth/jwt');

  const [{ id: tenantId, name }] = (await db.execute(
    sql`select t.id, t.name from tenants t join deals d on d.tenant_id = t.id
        where d.deleted_at is null group by t.id, t.name order by count(*) desc limit 1`,
  )) as unknown as Array<{ id: string; name: string }>;
  const [{ user_id: userId }] = (await db.execute(
    sql`select user_id from memberships
        where tenant_id = ${tenantId}::uuid and role in ('owner','admin') limit 1`,
  )) as unknown as Array<{ user_id: string }>;

  const token = await signSession({ sub: userId, tid: tenantId });
  const cookie = `crm_session=${token}`;
  console.log(`\n=== ${BASE}  ·  tenant "${name}"  ·  admin ${userId} ===\n`);

  const warm = await fetchTimed('/dashboard/deals', cookie);
  if (warm.status !== 200) {
    console.error(`got HTTP ${warm.status} — is the server running and the session valid?`);
    process.exit(2);
  }

  /* A. the deals page, alone (no competing traffic) ------------------- */
  const solo: Timing[] = [];
  for (let i = 0; i < 5; i++) solo.push(await fetchTimed('/dashboard/deals', cookie));
  const s = {
    ttfb: p50(solo.map((x) => x.ttfb)),
    stream: p50(solo.map((x) => x.stream)),
    total: p50(solo.map((x) => x.total)),
  };
  console.log('A. /dashboard/deals — no competing traffic');
  console.log(
    `   TTFB ${s.ttfb.toFixed(0)}ms   stream ${s.stream.toFixed(0)}ms   total ${s.total.toFixed(0)}ms`,
  );
  console.log(
    `   wire ${(solo[0]!.wireBytes / 1024).toFixed(1)} KB (${solo[0]!.encoding})` +
      `   uncompressed ${(solo[0]!.rawBytes / 1024).toFixed(1)} KB` +
      `   ratio ${(solo[0]!.rawBytes / solo[0]!.wireBytes).toFixed(1)}x\n`,
  );

  /* B. sidebar prefetch fan-out ---------------------------------------- */
  console.log(`B. sidebar prefetch fan-out (${SIDEBAR.length} routes, as production fires them)`);
  const pf0 = performance.now();
  const pf = await Promise.all(SIDEBAR.map((p) => fetchTimed(p, cookie, true)));
  const pfTotal = performance.now() - pf0;
  const pfBytes = pf.reduce((a, x) => a + x.wireBytes, 0);
  console.log(
    `   ${SIDEBAR.length} concurrent ?_rsc= requests   ${pfTotal.toFixed(0)}ms wall   ` +
      `${(pfBytes / 1024).toFixed(0)} KB transferred`,
  );
  const slow = [...pf]
    .map((x, i) => ({ path: SIDEBAR[i]!, ...x }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
  for (const x of slow) {
    console.log(`     ${x.total.toFixed(0).padStart(6)}ms  ${(x.wireBytes / 1024).toFixed(1).padStart(7)} KB  ${x.path}`);
  }

  /* B2. what one prefetch actually costs the server -------------------- */
  console.log('\nB2. cost of a single prefetch on an idle server (is it real work?)');
  for (const p of ['/dashboard/team', '/dashboard/reports', '/dashboard/intelligence']) {
    const one: number[] = [];
    for (let i = 0; i < 3; i++) one.push((await fetchTimed(p, cookie, true)).total);
    console.log(`   ${p.padEnd(28)} ${p50(one).toFixed(0).padStart(5)}ms per prefetch`);
  }

  /* C. the deals page WHILE the prefetch storm runs --------------------- */
  console.log('\nC. /dashboard/deals loading *while* the prefetch fan-out runs');
  const storm: Timing[] = [];
  for (let i = 0; i < 3; i++) {
    const race = Promise.all(SIDEBAR.map((p) => fetchTimed(p, cookie, true)));
    storm.push(await fetchTimed('/dashboard/deals', cookie));
    await race;
  }
  const c = {
    ttfb: p50(storm.map((x) => x.ttfb)),
    stream: p50(storm.map((x) => x.stream)),
    total: p50(storm.map((x) => x.total)),
  };
  console.log(
    `   TTFB ${c.ttfb.toFixed(0)}ms   stream ${c.stream.toFixed(0)}ms   total ${c.total.toFixed(0)}ms`,
  );
  console.log(
    `   → contention costs ${(c.total - s.total).toFixed(0)}ms ` +
      `(${(c.total / s.total).toFixed(1)}x slower), almost all of it in "Content Download"\n`,
  );

  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
