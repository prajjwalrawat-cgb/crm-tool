/**
 * Read-only payload probe. Node's fetch (undici) transparently decompresses,
 * which hides the real wire size — so this uses a raw socket to capture the
 * exact bytes on the network, then breaks the document down by content.
 *
 *   BASE=http://localhost:3100 npx tsx --require ./scripts/_shim-server-only.cjs scripts/_perf-payload.ts
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { connect } from 'node:net';

config({ path: '.env.local' });
config();

const BASE = new URL(process.env.BASE ?? 'http://localhost:3100');
const KB = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** Raw HTTP/1.1 GET so we see exactly what crosses the wire. */
function rawGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ head: string; bodyBytes: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const sock = connect(Number(BASE.port || 80), BASE.hostname, () => {
      const h = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${BASE.host}\r\nConnection: close\r\n${h}\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf('\r\n\r\n');
      resolve({
        head: all.subarray(0, split).toString('latin1'),
        bodyBytes: all.length - split - 4,
        body: all.subarray(split + 4),
      });
    });
    sock.on('error', reject);
    sock.setTimeout(60000, () => reject(new Error('timeout')));
  });
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
  const cookie = `crm_session=${await signSession({ sub: userId, tid: tenantId })}`;

  console.log(`\n=== ${BASE.origin}/dashboard/deals · tenant "${name}" ===\n`);

  const plain = await rawGet('/dashboard/deals', { cookie });
  const gz = await rawGet('/dashboard/deals', { cookie, 'accept-encoding': 'gzip' });
  const br = await rawGet('/dashboard/deals', { cookie, 'accept-encoding': 'br' });

  const enc = (h: string) =>
    (/content-encoding:\s*(\S+)/i.exec(h)?.[1] ?? 'identity').trim();

  console.log('wire size of the document');
  console.log(`   no accept-encoding      ${KB(plain.bodyBytes).padStart(10)}   (${enc(plain.head)})`);
  console.log(`   accept-encoding: gzip   ${KB(gz.bodyBytes).padStart(10)}   (${enc(gz.head)})`);
  console.log(`   accept-encoding: br     ${KB(br.bodyBytes).padStart(10)}   (${enc(br.head)})`);
  if (enc(gz.head) === 'gzip') {
    console.log(`   → gzip saves ${(100 - (gz.bodyBytes / plain.bodyBytes) * 100).toFixed(0)}%`);
  } else {
    console.log('   → NOT COMPRESSED: the server returned identity for a gzip-capable client');
  }

  console.log('\nresponse headers');
  for (const line of plain.head.split('\r\n').slice(1)) {
    if (/^(content-|cache-|vary|transfer-|x-)/i.test(line)) console.log(`   ${line}`);
  }

  /* what is actually in those bytes ----------------------------------- */
  const html = plain.body.toString('utf8');
  const rsc = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)]
    .map((m) => m[1]!)
    .join('');
  const scripts = [...html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)]
    .reduce((a, m) => a + m[0].length, 0);
  const inlineStyle = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)]
    .reduce((a, m) => a + m[0].length, 0);

  console.log('\ndocument breakdown');
  console.log(`   total HTML             ${KB(html.length).padStart(10)}`);
  console.log(`   RSC flight payload     ${KB(rsc.length).padStart(10)}   (inlined __next_f)`);
  console.log(`   all <script> blocks    ${KB(scripts).padStart(10)}`);
  console.log(`   inline <style>         ${KB(inlineStyle).padStart(10)}`);
  console.log(`   rendered markup        ${KB(html.length - scripts - inlineStyle).padStart(10)}`);

  /* how much of the flight payload is each prop bundle? --------------- */
  console.log('\nlargest repeated keys in the RSC payload (props serialized to the client)');
  const keyCounts = new Map<string, { n: number; bytes: number }>();
  for (const m of rsc.matchAll(/\\"([a-zA-Z_][a-zA-Z0-9_]*)\\":/g)) {
    const k = m[1]!;
    const cur = keyCounts.get(k) ?? { n: 0, bytes: 0 };
    cur.n += 1;
    cur.bytes += k.length + 6;
    keyCounts.set(k, cur);
  }
  const top = [...keyCounts.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 18);
  for (const [k, v] of top) {
    console.log(`   ${k.padEnd(28)} ${String(v.n).padStart(5)}x   ${KB(v.bytes).padStart(9)} in keys alone`);
  }

  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
