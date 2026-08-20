/**
 * Unit self-test for deploy-time infrastructure invariants. No DB queries.
 *   pnpm tsx scripts/selftest-deploy-config.ts
 *
 * Guards compute/database colocation.
 *
 * Why this needs a test: the app ran for months with functions in `iad1`
 * (Washington DC) and Postgres in `ap-south-1` (Mumbai). Nothing failed —
 * it was simply slow, everywhere, for everyone. A dashboard render issues
 * 21+ RLS transactions, and every one costs 4 round trips (BEGIN,
 * app_set_ctx, query, COMMIT), so ~84 round trips ran across a continent
 * and back. Measured: 1.9s locally against the same database vs 10.9s in
 * production, with TTFB healthy in both. The only difference was distance.
 *
 * There is no runtime error for this, no log line, and no local symptom —
 * the sole artefact is `x-vercel-id: bom1::iad1::…` on a response header.
 * So assert it instead: whatever region vercel.json pins, it must match the
 * region the DATABASE_URL points at.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from 'dotenv';

config({ path: '.env.local' });
config();

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

/** Vercel edge region -> the AWS region it sits in. */
const VERCEL_TO_AWS: Record<string, string> = {
  arn1: 'eu-north-1',
  bom1: 'ap-south-1',
  cdg1: 'eu-west-3',
  cle1: 'us-east-2',
  cpt1: 'af-south-1',
  dub1: 'eu-west-1',
  fra1: 'eu-central-1',
  gru1: 'sa-east-1',
  hnd1: 'ap-northeast-1',
  iad1: 'us-east-1',
  icn1: 'ap-northeast-2',
  kix1: 'ap-northeast-3',
  lhr1: 'eu-west-2',
  pdx1: 'us-west-2',
  sfo1: 'us-west-1',
  sin1: 'ap-southeast-1',
  syd1: 'ap-southeast-2',
};

const vercelJson = JSON.parse(
  readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'),
) as { regions?: string[] };

const regions = vercelJson.regions ?? [];

check(
  'vercel.json pins exactly one function region',
  regions.length === 1,
  `regions=${JSON.stringify(regions)}`,
);

const region = regions[0];
check(
  'the pinned region is a region Vercel actually has',
  typeof region === 'string' && region in VERCEL_TO_AWS,
  `region=${region}`,
);

// DATABASE_URL is absent in CI / fresh clones — skip rather than fail there,
// since the point of this check is the pairing, not the secret.
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.log('SKIP  compute/database colocation (no DATABASE_URL in env)');
} else {
  const host = new URL(dbUrl).host;
  const awsRegion = region ? VERCEL_TO_AWS[region] : undefined;
  const colocated = Boolean(awsRegion && host.includes(awsRegion));
  check(
    'functions run in the same AWS region as the database',
    colocated,
    `functions=${region} (${awsRegion}) vs db=${host}`,
  );
}

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed.`);
process.exit(exitCode);
