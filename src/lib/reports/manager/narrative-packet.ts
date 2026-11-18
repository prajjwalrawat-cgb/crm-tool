import type Anthropic from '@anthropic-ai/sdk';

import { METRICS, metricValue, type MetricKey } from '../metrics';
import { sumCounters, topMovers, type FactCounters } from './math';
import { NARRATIVE_JSON_SCHEMA, NarrativeSchema, validateActionMetrics, validateNarrativeNumbers, type Narrative } from './narrative-guard';
import type { ResolvedRange } from './time';

/**
 * Pure half of the AI narrative: the aggregates-only facts packet, the exact
 * request sent to Claude, and the output checks. No I/O, so the no-PII and
 * number-guard tests run against the real code path.
 */

export const NARRATIVE_MODEL = 'claude-sonnet-5-5';
const MIN_SAMPLE = 20;

const PACKET_METRICS: MetricKey[] = ['lead_volume', 'qualified', 'quotes_sent', 'won_count', 'won_value', 'win_rate', 'calls_made', 'contact_rate', 'talk_time', 'activities_per_rep_per_day'];
const MOVER_METRICS: MetricKey[] = ['lead_volume', 'won_value', 'won_count', 'calls_made', 'qualified'];

export type FactsPacket = {
  period: { from: string; to: string; days: number };
  previous_period: { from: string; to: string; days: number };
  reps_in_scope: number;
  metrics: Array<{ metric: string; label: string; unit: string; current: number | null; previous: number | null; change: number | null; change_pct: number | null }>;
  sla: { current_pct: number | null; previous_pct: number | null; current_due: number; previous_due: number };
  top_movers: Array<{ metric: string; segment: string; current: number; previous: number; change: number; change_pct: number | null; sample_size: number }>;
  rules: { min_sample_size: number };
};

export type NarrativeResult =
  | { status: 'ok'; narrative: Narrative; generatedAt: string; cached: boolean }
  | { status: 'unavailable'; reason: string; generatedAt: string; cached: boolean }
  | { status: 'disabled'; reason: string };

function changeOf(cur: number | null, prev: number | null) {
  if (cur === null || prev === null) return { change: null, change_pct: null };
  return { change: Math.round((cur - prev) * 100) / 100, change_pct: prev !== 0 ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null };
}

/** Build the aggregates-only packet + the pseudonym map. Exported for tests. */
export function buildFactsPacket(input: {
  range: ResolvedRange;
  compare: ResolvedRange;
  cur: { rows: Array<FactCounters & { ownerId: string; sourceId: string | null }> };
  prev: { rows: Array<FactCounters & { ownerId: string; sourceId: string | null }> };
  reps: number;
  sla: { cur: { compliancePct: number | null; due: number }; prev: { compliancePct: number | null; due: number } };
  sourceNames: Map<string, string>;
}): { packet: FactsPacket; pseudonyms: Map<string, string> } {
  const { range, compare, cur, prev } = input;
  const ctx = { reps: input.reps, days: range.days };
  const pctx = { reps: input.reps, days: compare.days };
  const curT = sumCounters(cur.rows);
  const prevT = sumCounters(prev.rows);

  const pseudonyms = new Map<string, string>();
  const ownerIds = [...new Set([...cur.rows, ...prev.rows].map((r) => r.ownerId).filter(Boolean))].sort();
  ownerIds.forEach((id, i) => pseudonyms.set(id, `Rep ${i + 1}`));

  const group = (rows: typeof cur.rows, by: 'owner' | 'source') => {
    const m = new Map<string, FactCounters[]>();
    for (const r of rows) {
      const k = by === 'owner' ? r.ownerId : (r.sourceId ?? '');
      if (by === 'owner' && !k) continue;
      if (by === 'source' && !r.sourceId && r.leadsCreated === 0 && r.wonCount === 0) continue;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return new Map([...m].map(([k, v]) => [k, sumCounters(v)]));
  };
  const curOwner = group(cur.rows, 'owner');
  const prevOwner = group(prev.rows, 'owner');
  const curSrc = group(cur.rows, 'source');
  const prevSrc = group(prev.rows, 'source');

  const movers: FactsPacket['top_movers'] = [];
  for (const metric of MOVER_METRICS) {
    const candidates: Array<{ key: string; label: string; current: number; previous: number; sample: number }> = [];
    for (const k of new Set([...curOwner.keys(), ...prevOwner.keys()])) {
      const c = curOwner.get(k);
      const p = prevOwner.get(k);
      candidates.push({
        key: `owner:${k}`,
        label: pseudonyms.get(k) ?? 'Rep ?',
        current: (c ? metricValue(metric, c, { reps: 1, days: range.days }) : 0) ?? 0,
        previous: (p ? metricValue(metric, p, { reps: 1, days: compare.days }) : 0) ?? 0,
        sample: (c?.leadsCreated ?? 0) + (c?.wonCount ?? 0) + (c?.callsMade ?? 0),
      });
    }
    for (const k of new Set([...curSrc.keys(), ...prevSrc.keys()])) {
      const c = curSrc.get(k);
      const p = prevSrc.get(k);
      candidates.push({
        key: `source:${k}`,
        label: `Source: ${k ? (input.sourceNames.get(k) ?? 'Deleted source') : 'No source'}`,
        current: (c ? metricValue(metric, c, { reps: 1, days: range.days }) : 0) ?? 0,
        previous: (p ? metricValue(metric, p, { reps: 1, days: compare.days }) : 0) ?? 0,
        sample: (c?.leadsCreated ?? 0) + (c?.wonCount ?? 0),
      });
    }
    const sampleBy = new Map(candidates.map((c) => [c.key, c.sample]));
    for (const m of topMovers(candidates.map(({ key, label, current, previous }) => ({ key, label, current, previous })), 5)) {
      movers.push({ metric, segment: m.label, current: m.current, previous: m.previous, change: m.absolute, change_pct: m.percent, sample_size: sampleBy.get(m.key) ?? 0 });
    }
  }

  const packet: FactsPacket = {
    period: { from: range.fromDay, to: range.toDay, days: range.days },
    previous_period: { from: compare.fromDay, to: compare.toDay, days: compare.days },
    reps_in_scope: input.reps,
    metrics: PACKET_METRICS.map((key) => {
      const c = metricValue(key, curT, ctx);
      const p = metricValue(key, prevT, pctx);
      return { metric: key, label: METRICS[key].label, unit: METRICS[key].unit, current: c, previous: p, ...changeOf(c, p) };
    }),
    sla: { current_pct: input.sla.cur.compliancePct, previous_pct: input.sla.prev.compliancePct, current_due: input.sla.cur.due, previous_due: input.sla.prev.due },
    top_movers: movers,
    rules: { min_sample_size: MIN_SAMPLE },
  };
  return { packet, pseudonyms };
}

export const SYSTEM_PROMPT = [
  'You write a short "what changed and why" briefing for a B2B sales manager.',
  'You receive a JSON facts packet of aggregates: this period vs the previous period, and the top movers by rep (pseudonymised as "Rep N") and by lead source.',
  'Rules:',
  '- Cite only numbers that appear in the facts packet. Do not compute new numbers, totals, averages or percentages, and do not invent dates.',
  '- Never state a cause as fact. Drivers are hypotheses: use "likely" or "may".',
  '- If a segment has sample_size below rules.min_sample_size, say it is too small to conclude anything from.',
  '- If something is unclear from the packet, say "unclear" rather than guessing.',
  '- actions_for_manager: at most 3, each tied to one metric key from the packet (put the key, e.g. "contact_rate", in the metric field).',
  '- Keep the headline under 20 words and each bullet to one sentence.',
].join('\n');


/** The exact Messages API request body (tests assert on it). */
export function buildNarrativeRequest(
  packet: FactsPacket,
  messages: Anthropic.MessageParam[] = [{ role: 'user', content: JSON.stringify(packet) }],
): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming & { fallbacks?: 'default' } = {
    model: NARRATIVE_MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: NARRATIVE_JSON_SCHEMA as unknown as Record<string, unknown> } },
    messages,
    // Server-side refusal fallback (routes by refusal category).
    fallbacks: 'default',
  };
  return params;
}

/**
 * Validate a raw model response against the packet. Exported for the guard
 * test (feeds a mocked response with a number that is not in the packet).
 */
export function checkModelOutput(raw: string, packet: FactsPacket): { ok: true; narrative: Narrative } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  const parsed = NarrativeSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const nums = validateNarrativeNumbers(parsed.data, packet);
  if (!nums.ok) return { ok: false, reason: `numbers not in facts packet: ${nums.offending.slice(0, 5).join(', ')}` };
  const metricKeys = [...new Set([...packet.metrics.map((m) => m.metric), ...packet.top_movers.map((m) => m.metric), 'sla_compliance_pct'])];
  if (!validateActionMetrics(parsed.data, metricKeys)) return { ok: false, reason: 'action tied to an unknown metric' };
  return { ok: true, narrative: parsed.data };
}

