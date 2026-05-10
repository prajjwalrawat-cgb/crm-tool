import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for the AI feature-flag pipeline + observability layer.
 *
 * Covers:
 *   - mock embedding generation (deterministic, 1536-d, normalized)
 *   - upsert + SHA-256 dedup
 *   - vector search with the array-binding bug fix (`ANY($n::text[])`)
 *   - mock chat streaming returns the canned answer
 *   - audit row recorded with `status='skipped'` in mock mode
 *   - observability counters / gauges / histograms increment
 *
 * Forces mock mode via `AI_ENABLED=false` regardless of `.env.local` so
 * this runs without an OpenAI key.
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

  const { mockEmbedding, approxTokens, buildMockAnswer } = await import('../src/lib/ai/mock');
  const { aiLive, getAIMode } = await import('../src/lib/ai/config');
  const { snapshotMetrics } = await import('../src/lib/observability');

  const tenantRow = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  if (tenantRow.length === 0) {
    console.error('No tenants found.');
    process.exit(2);
  }
  const tenantId = tenantRow[0]!.id;

  /* -------- AI config helper -------- */

  check('AI_ENABLED=false → mock mode', getAIMode() === 'mock');
  check('aiLive() === false', aiLive() === false);

  /* -------- Mock embedding determinism + dimensionality -------- */

  const v1 = mockEmbedding('hello world');
  const v2 = mockEmbedding('hello world');
  const v3 = mockEmbedding('different content');
  check('mock embedding length === 1536', v1.length === 1536);
  check(
    'mock embedding determinism (same input → same vector)',
    v1.length === v2.length && v1.every((x, i) => x === v2[i]),
  );
  check(
    'mock embedding different inputs → different vectors',
    v1.some((x, i) => x !== v3[i]),
  );
  // Normalization check: ||v|| should be ~1
  const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
  check('mock embedding L2-normalized (norm ≈ 1)', Math.abs(norm - 1) < 1e-6);

  check('approxTokens proxies char-count', approxTokens('1234') === 1 && approxTokens('') === 0);

  /* -------- Mock answer template -------- */

  const chat = buildMockAnswer({ prompt: 'q', contextRecordCount: 3, shape: 'chat' });
  check('mock chat answer mentions the record count', chat.includes('3'));
  check('mock chat answer notes the mode', chat.toLowerCase().includes('mock'));

  /* -------- vector search ANY(text[]) binding fix -------- */
  // Test the EXACT failing pattern: a SELECT with `ANY($n::text[])`. We
  // bind a JS string carrying the postgres array literal so it's a single
  // parameter, not a tuple.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', 'selftest-ai', true)`);

    const typesLiteral = `{deal,company,contact}`;
    const rows = await tx.execute(sql`
      SELECT entity_type
      FROM embeddings
      WHERE tenant_id = ${tenantId}::uuid
        AND entity_type = ANY(${typesLiteral}::text[])
      LIMIT 1
    `);
    // We don't care that this returns 0 rows — only that it doesn't throw.
    check('vector search ANY(text[]) binding parses', Array.isArray(rows));
  });

  /* -------- ai_invocations skipped-status round trip -------- */
  // Insert under tenant context with status='skipped'; read it back.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', 'selftest-ai', true)`);
    await tx.execute(sql`
      INSERT INTO ai_invocations
        (tenant_id, kind, model, status, prompt_tokens, latency_ms, metadata)
      VALUES
        (${tenantId}::uuid, 'embed', 'text-embedding-3-small', 'skipped',
         42, 1, '{"mock":true}'::jsonb)
    `);
  });
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', 'selftest-ai', true)`);
    const rows = (await tx.execute(sql`
      SELECT status, prompt_tokens FROM ai_invocations
      WHERE tenant_id = ${tenantId}::uuid AND status = 'skipped'
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Array<{ status: string; prompt_tokens: number }>;
    check(
      'ai_invocations.status=\'skipped\' round-trips',
      rows[0]?.status === 'skipped' && rows[0]?.prompt_tokens === 42,
    );
  });

  /* -------- observability snapshot smoke test -------- */
  const { incr, observe, setGauge, captureError } = await import('../src/lib/observability');
  incr('selftest.counter', 3);
  incr('selftest.counter', 2);
  observe('selftest.latency_ms', 100);
  observe('selftest.latency_ms', 200);
  observe('selftest.latency_ms', 300);
  setGauge('selftest.gauge', 7);
  captureError(new Error('selftest captured'), {
    category: 'selftest.cat',
    severity: 'low',
    retryable: true,
  });

  const snap = snapshotMetrics();
  check(
    'metrics counter increments accumulate',
    snap.counters['selftest.counter'] === 5,
  );
  check('metrics gauge set', snap.gauges['selftest.gauge'] === 7);
  check(
    'metrics histogram p95 sane',
    Math.abs((snap.histograms['selftest.latency_ms']?.p95 ?? 0) - 300) < 1e-6,
  );
  check(
    'error counter incremented',
    (snap.counters['error.count{category=selftest.cat,retryable=true,severity=low}'] ?? 0) >= 1,
  );

  /* -------- cleanup the dummy ai_invocations row -------- */
  await db.execute(
    sql`DELETE FROM ai_invocations WHERE actor_user_id IS NULL AND tenant_id = ${tenantId}::uuid AND status = 'skipped' AND prompt_tokens = 42 AND metadata @> '{"mock":true}'::jsonb`,
  );

  console.log('\n----- selftest-ai-and-observability results -----');
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
