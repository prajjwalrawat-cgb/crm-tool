import 'server-only';

import { createHash } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';

import { recordAiInvocation } from '@/lib/ai/audit';
import { tenantTransaction } from '@/lib/db-context';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { captureError } from '@/lib/observability';

import { readFacts } from './rollup';
import { depseudonymise, findPii, type Narrative } from './narrative-guard';
import {
  NARRATIVE_MODEL,
  buildFactsPacket,
  buildNarrativeRequest,
  checkModelOutput,
  type FactsPacket,
  type NarrativeResult,
} from './narrative-packet';

export type { NarrativeResult } from './narrative-packet';
import type { ReportScope } from './scope';
import { peopleById, repsInScope, slaStats } from './services';
import type { ResolvedRange } from './time';

/**
 * AI "what changed and why". Aggregates only:
 *   - reps are pseudonymised ("Rep 1…n") and mapped back to names only
 *     AFTER the output has passed every check;
 *   - lead names, phones, emails and free text never enter the packet, and
 *     `findPii` re-checks the packet (against the real rep names too)
 *     before anything is sent — a hit aborts the call;
 *   - every number the model writes must exist in the packet, or the
 *     narrative is dropped and the UI shows "Narrative unavailable".
 * Cached per (tenant, scope, range, compare) for 30 minutes.
 */

const CACHE_MS = 30 * 60_000;
const FAIL_CACHE_MS = 5 * 60_000;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export function narrativeAvailable(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0;
}

function cacheKey(scope: ReportScope, range: ResolvedRange, compare: ResolvedRange): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.userIds?.slice().sort() ?? '*', range.fromDay, range.toDay, compare.fromDay, compare.toDay]))
    .digest('hex');
}

async function callModel(packet: FactsPacket, prior: { raw: string; error: string } | null): Promise<{ raw: string; usage: { in: number; out: number }; refused: boolean }> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: JSON.stringify(packet) }];
  if (prior) {
    messages.push({ role: 'assistant', content: prior.raw || '{}' });
    messages.push({ role: 'user', content: `Your previous answer was rejected: ${prior.error}. Return the JSON again, following the schema and rules exactly.` });
  }
  const params = buildNarrativeRequest(packet, messages);
  const res = await getClient().messages.create(params as Anthropic.MessageCreateParamsNonStreaming, {
    headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' },
  });
  const raw = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { raw, usage: { in: res.usage?.input_tokens ?? 0, out: res.usage?.output_tokens ?? 0 }, refused: res.stop_reason === 'refusal' };
}

export async function generateNarrative(args: {
  scope: ReportScope;
  range: ResolvedRange;
  compare: ResolvedRange;
  force?: boolean;
}): Promise<NarrativeResult> {
  const { scope, range, compare } = args;
  const settings = await getOrgSettings(scope.tenantId);
  if (!settings.reportNarrativeEnabled || !settings.aiEnabled) return { status: 'disabled', reason: 'Turned off for this workspace.' };
  if (!narrativeAvailable()) return { status: 'disabled', reason: 'No AI key configured.' };

  const key = cacheKey(scope, range, compare);
  if (!args.force) {
    const rows = (await tenantTransaction((tx) =>
      tx.execute(sql`SELECT narrative, status, created_at FROM report_narrative_cache WHERE tenant_id = ${scope.tenantId}::uuid AND cache_key = ${key}`),
    )) as unknown as Array<{ narrative: Narrative | null; status: string; created_at: string }>;
    const hit = rows[0];
    if (hit) {
      const age = Date.now() - new Date(hit.created_at).getTime();
      if (hit.status === 'ok' && hit.narrative && age < CACHE_MS) return { status: 'ok', narrative: hit.narrative, generatedAt: new Date(hit.created_at).toISOString(), cached: true };
      if (hit.status !== 'ok' && age < FAIL_CACHE_MS) return { status: 'unavailable', reason: 'Recently failed; try again shortly.', generatedAt: new Date(hit.created_at).toISOString(), cached: true };
    }
  }

  const [cur, prev, reps, slaCur, slaPrev, sources] = await Promise.all([
    readFacts(scope, range),
    readFacts(scope, compare),
    repsInScope(scope),
    slaStats(scope, range),
    slaStats(scope, compare),
    tenantTransaction((tx) => tx.execute(sql`SELECT id::text, name FROM lead_sources WHERE tenant_id = ${scope.tenantId}::uuid`)) as unknown as Promise<Array<{ id: string; name: string }>>,
  ]);
  const { packet, pseudonyms } = buildFactsPacket({
    range,
    compare,
    cur,
    prev,
    reps: reps.length,
    sla: { cur: slaCur.total, prev: slaPrev.total },
    sourceNames: new Map(sources.map((s) => [s.id, s.name])),
  });
  const people = await peopleById([...pseudonyms.keys()]);
  const sensitive = [...people.values()].flatMap((p) => [p.name, p.email ?? '']).filter(Boolean);
  const pii = findPii(packet, sensitive);
  const save = async (status: string, narrative: Narrative | null) =>
    tenantTransaction((tx) =>
      tx.execute(sql`
        INSERT INTO report_narrative_cache (tenant_id, cache_key, narrative, status, created_at)
        VALUES (${scope.tenantId}::uuid, ${key}, ${narrative ? JSON.stringify(narrative) : null}::jsonb, ${status}, now())
        ON CONFLICT (tenant_id, cache_key) DO UPDATE SET narrative = EXCLUDED.narrative, status = EXCLUDED.status, created_at = now()`),
    );
  if (pii.length) {
    captureError(new Error('narrative packet contained PII-like values'), { category: 'reports.narrative.pii_blocked', severity: 'high', fields: { count: pii.length } });
    await save('blocked', null);
    return { status: 'unavailable', reason: 'Narrative unavailable.', generatedAt: new Date().toISOString(), cached: false };
  }

  const startedAt = Date.now();
  let lastReason = 'unknown';
  let usage = { in: 0, out: 0 };
  try {
    let prior: { raw: string; error: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await callModel(packet, prior);
      usage = { in: usage.in + out.usage.in, out: usage.out + out.usage.out };
      if (out.refused) {
        lastReason = 'model declined';
        break;
      }
      const checked = checkModelOutput(out.raw, packet);
      if (checked.ok) {
        const names = Object.fromEntries([...pseudonyms].map(([id, alias]) => [alias, people.get(id)?.name ?? alias]));
        const narrative = depseudonymise(checked.narrative, names);
        await save('ok', narrative);
        await recordAiInvocation({
          tenantId: scope.tenantId,
          actorUserId: scope.viewerUserId,
          kind: 'summary',
          model: NARRATIVE_MODEL,
          promptTokens: usage.in,
          completionTokens: usage.out,
          totalTokens: usage.in + usage.out,
          latencyMs: Date.now() - startedAt,
          status: 'success',
          error: null,
          metadata: { feature: 'report_narrative', attempts: attempt + 1 },
        });
        return { status: 'ok', narrative, generatedAt: new Date().toISOString(), cached: false };
      }
      lastReason = checked.reason;
      // A number that isn't in the packet is not retried: drop it.
      if (checked.reason.startsWith('numbers')) break;
      prior = { raw: out.raw, error: checked.reason };
    }
  } catch (err) {
    lastReason = err instanceof Anthropic.RateLimitError ? 'rate limited' : err instanceof Anthropic.APIError ? `api ${err.status}` : 'request failed';
    captureError(err, { category: 'reports.narrative.failed', severity: 'low', retryable: true });
  }
  await save('unavailable', null);
  await recordAiInvocation({
    tenantId: scope.tenantId,
    actorUserId: scope.viewerUserId,
    kind: 'summary',
    model: NARRATIVE_MODEL,
    promptTokens: usage.in,
    completionTokens: usage.out,
    totalTokens: usage.in + usage.out,
    latencyMs: Date.now() - startedAt,
    status: 'error',
    error: lastReason,
    metadata: { feature: 'report_narrative' },
  });
  return { status: 'unavailable', reason: 'Narrative unavailable.', generatedAt: new Date().toISOString(), cached: false };
}

