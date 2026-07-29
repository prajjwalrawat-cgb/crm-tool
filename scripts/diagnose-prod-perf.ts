/**
 * Production performance diagnostic. Read-only, no writes, no auth secrets
 * printed. Run it against the deployed app to resolve the two unknowns that
 * code inspection cannot answer:
 *
 *   1. Is the HTML/RSC response actually compressed in production?
 *      Locally `next start` gzips it 574 KB -> 52 KB. A proxy/CDN that
 *      terminates TLS and forwards uncompressed would put the full 574 KB
 *      on the wire — which is exactly what a large "Content Download"
 *      looks like in DevTools.
 *
 *   2. How far is the app server from the database?
 *      Every RLS-scoped query costs 4 round trips (BEGIN + app_set_ctx +
 *      query + COMMIT), so server<->DB latency is a direct multiplier on
 *      every page. Supabase is in aws-1-ap-south-1 (Mumbai).
 *
 * Usage — from a shell that can reach production:
 *
 *   PROD_URL=https://your-app.example.com \
 *   PROD_COOKIE='crm_session=...' \
 *   npx tsx --require ./scripts/_shim-server-only.cjs scripts/diagnose-prod-perf.ts
 *
 * Get PROD_COOKIE by signing in to production in a browser, opening
 * DevTools > Application > Cookies, and copying the `crm_session` value.
 * It is a session token — do not paste it into a shared channel.
 */
import { config } from 'dotenv';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

const RAW_URL = process.env.PROD_URL;
const PATH = process.env.PROD_PATH ?? '/dashboard/deals';

// Accept either the full `crm_session=<jwt>` pair or a bare JWT copied
// straight out of the DevTools "Value" column — the bare form is the
// easy mistake, and it silently redirects to /sign-in instead of failing.
const RAW_COOKIE = (process.env.PROD_COOKIE ?? '').trim();
const COOKIE =
  RAW_COOKIE && !RAW_COOKIE.includes('=')
    ? `crm_session=${RAW_COOKIE}`
    : RAW_COOKIE;

if (!RAW_URL) {
  console.error('Set PROD_URL (and ideally PROD_COOKIE). See the header of this file.');
  process.exit(2);
}
const URL_ = new URL(RAW_URL);
const isTls = URL_.protocol === 'https:';
const PORT = Number(URL_.port || (isTls ? 443 : 80));
const KB = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** Raw socket GET so we observe the true on-the-wire byte count. */
function rawGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ head: string; bodyBytes: number; ttfb: number; total: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let ttfb = 0;
    const onConnect = () => {
      // Each header line carries its own CRLF; the blank line that ends
      // the request is appended once. Building it any other way emits a
      // stray CRLF when `headers` is empty, which the server reads as a
      // second, malformed request and answers with 400.
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${URL_.hostname}`,
        'Connection: close',
        'User-Agent: crm-perf-diagnostic',
        ...Object.entries(headers)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`),
      ];
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    };
    const sock = isTls
      ? tlsConnect({ host: URL_.hostname, port: PORT, servername: URL_.hostname }, onConnect)
      : connect(PORT, URL_.hostname, onConnect);

    const chunks: Buffer[] = [];
    sock.on('data', (d: Buffer) => {
      if (!ttfb) ttfb = performance.now() - t0;
      chunks.push(d);
    });
    sock.on('end', () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf('\r\n\r\n');
      resolve({
        head: all.subarray(0, split).toString('latin1'),
        bodyBytes: all.length - split - 4,
        ttfb,
        total: performance.now() - t0,
      });
    });
    sock.on('error', reject);
    sock.setTimeout(90_000, () => reject(new Error('timeout')));
  });
}

const header = (head: string, name: string) =>
  new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head)?.[1]?.trim() ?? null;

async function main() {
  console.log(`\n=== production diagnostic: ${URL_.origin}${PATH} ===\n`);
  if (!COOKIE) {
    console.log('! No PROD_COOKIE set — expect a redirect to /sign-in. Compression\n' +
      '  numbers will reflect the sign-in page, not the deals page.\n');
  }

  /* 1. compression --------------------------------------------------- */
  const base = { cookie: COOKIE };
  const plain = await rawGet(PATH, base);
  const gzip = await rawGet(PATH, { ...base, 'accept-encoding': 'gzip, deflate' });
  const brotli = await rawGet(PATH, { ...base, 'accept-encoding': 'gzip, deflate, br' });

  const status = (h: string) => h.split('\r\n')[0] ?? '';
  const code = Number(/\s(\d{3})\s/.exec(status(plain.head))?.[1] ?? 0);
  console.log(`status: ${status(plain.head)}`);

  // A redirect or error has little or no body, and every size-based
  // conclusion below would be meaningless (an empty body looks exactly
  // like an uncompressed one). Stop rather than report nonsense.
  if (code !== 200) {
    const to = header(plain.head, 'location');
    console.log(
      `\n>> Not measuring: the server returned ${code}` +
        (to ? ` -> ${to}` : '') +
        `.\n` +
        (code === 307 || code === 302 || code === 308
          ? `   That is the auth redirect, so PROD_COOKIE is not being accepted.\n` +
            `   Check that you copied the FULL value of the \`crm_session\` cookie\n` +
            `   and that it has not expired (sessions last 7 days).\n`
          : `   Check PROD_URL and PROD_PATH.\n`),
    );
    process.exit(1);
  }

  console.log('\n1. compression');
  console.log(`   identity        ${KB(plain.bodyBytes).padStart(10)}  enc=${header(plain.head, 'content-encoding') ?? 'none'}`);
  console.log(`   gzip offered    ${KB(gzip.bodyBytes).padStart(10)}  enc=${header(gzip.head, 'content-encoding') ?? 'none'}`);
  console.log(`   br offered      ${KB(brotli.bodyBytes).padStart(10)}  enc=${header(brotli.head, 'content-encoding') ?? 'none'}`);

  const enc = header(brotli.head, 'content-encoding');
  if (!enc) {
    console.log(
      `\n   >> PROBLEM: production is NOT compressing this response.\n` +
        `      The browser is downloading ~${KB(plain.bodyBytes)} instead of ~${KB(plain.bodyBytes / 11)}.\n` +
        `      Fix at the proxy/CDN (enable gzip or brotli for text/html and\n` +
        `      text/x-component), or ensure Next serves the response directly.`,
    );
  } else {
    const saved = 100 - (brotli.bodyBytes / plain.bodyBytes) * 100;
    console.log(`\n   OK: compressed with ${enc} (${saved.toFixed(0)}% smaller). Not the bottleneck.`);
  }

  /* 2. timing split --------------------------------------------------- */
  console.log('\n2. timing (5 samples)');
  const samples: Array<{ ttfb: number; total: number; bytes: number }> = [];
  for (let i = 0; i < 5; i++) {
    const r = await rawGet(PATH, { ...base, 'accept-encoding': 'gzip, deflate, br' });
    samples.push({ ttfb: r.ttfb, total: r.total, bytes: r.bodyBytes });
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const ttfb = med(samples.map((s) => s.ttfb));
  const total = med(samples.map((s) => s.total));
  console.log(`   TTFB (shell)          ${ttfb.toFixed(0)}ms`);
  console.log(`   first byte -> last    ${(total - ttfb).toFixed(0)}ms   <- DevTools calls this "Content Download"`);
  console.log(`   total                 ${total.toFixed(0)}ms   for ${KB(med(samples.map((s) => s.bytes)))} on the wire`);
  const bandwidthMs = (med(samples.map((s) => s.bytes)) / (5 * 1024 * 1024)) * 1000;
  console.log(
    `\n   At 5 MB/s those bytes take ~${bandwidthMs.toFixed(0)}ms to transfer.\n` +
      `   Anything beyond that in "Content Download" is the server still\n` +
      `   producing the stream — i.e. waiting on the database, not the network.`,
  );

  /* 3. server -> database distance ------------------------------------ */
  console.log('\n3. app server <-> database latency');
  console.log('   (measured from THIS machine — run this script on the production');
  console.log('    host, or in the same region, for the number that matters)');
  const { db, client } = await import('../src/db/index');
  await db.execute(sql`select 1`);
  const rtts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = performance.now();
    await db.execute(sql`select 1`);
    rtts.push(performance.now() - a);
  }
  const rtt = med(rtts);
  console.log(`   DB host        ${new URL(process.env.DATABASE_URL!).host}`);
  console.log(`   round trip     ${rtt.toFixed(1)}ms`);
  console.log(`   one RLS query  ~${(rtt * 4).toFixed(0)}ms   (BEGIN + app_set_ctx + query + COMMIT)`);
  console.log(`   deals page     ~${(rtt * 4).toFixed(0)}ms floor for its 7 parallel queries,`);
  console.log(`                  plus the dashboard layout's own 4.`);
  if (rtt > 80) {
    console.log(
      `\n   >> The app server is far from the database. This is the single\n` +
        `      largest fixed cost per page and cannot be fixed in code —\n` +
        `      move the app to the database's region (aws ap-south-1).`,
    );
  }

  await client.end({ timeout: 5 });
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
