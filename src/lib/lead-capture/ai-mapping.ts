import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { logger } from '@/lib/observability';

import { LEAD_FIELD_KEYS, suggestMappingHeuristic, type LeadFieldKey } from './mapping';

/**
 * CSV column-mapping suggestion with Claude.
 *
 * PRIVACY: only the column HEADERS are sent — never a row, never a sample
 * value. The build prompt allowed up to 5 sample rows; this workspace's rule
 * is that lead PII stays local, so headers-only is the contract here (see
 * docs/BUILD_NOTES.md). The heuristic alias matcher runs first and is the
 * fallback whenever Claude is not configured, errors, refuses, or returns
 * anything that fails validation.
 */

const MODEL = process.env.ANTHROPIC_LEAD_MAPPING_MODEL?.trim() || 'claude-sonnet-5-5';
const MAX_HEADERS = 100;

export type MappingSuggestion = {
  mapping: Record<string, LeadFieldKey | null>;
  confidence: number;
  method: 'ai' | 'heuristic';
};

const responseSchema = z.object({
  mapping: z.record(z.string(), z.enum(LEAD_FIELD_KEYS).nullable()),
  confidence: z.number().min(0).max(1),
});

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mapping', 'confidence'],
  properties: {
    mapping: {
      type: 'object',
      description: 'Every CSV header as a key; value is the lead field it holds, or null.',
      additionalProperties: { anyOf: [{ type: 'string', enum: [...LEAD_FIELD_KEYS] }, { type: 'null' }] },
    },
    confidence: { type: 'number', description: '0 to 1: how sure you are about the mapping overall.' },
  },
} as const;

const SYSTEM = `You map spreadsheet column headers from Indian B2B lead exports (IndiaMART, JustDial, TradeIndia, trade-show lists, CRM exports) to a fixed set of lead fields.

Lead fields: ${LEAD_FIELD_KEYS.join(', ')}.
- full_name is a person's whole name; use first_name/last_name only when the columns are split.
- phone covers mobile, WhatsApp and landline columns; pick the primary one if several exist and map the rest to null.
- product_interest is what the buyer asked about (product, requirement, query).
- message is free-text enquiry or remarks.
- Map each lead field to at most one header. Map a header to null when it fits no field or is ambiguous.

You see only header names, never data. Return every header in "mapping".`;

let client: Anthropic | undefined;
function getClient(): Anthropic | null {
  if (!(process.env.ANTHROPIC_API_KEY ?? '').trim()) return null;
  client ??= new Anthropic();
  return client;
}

export async function suggestColumnMapping(headers: string[]): Promise<MappingSuggestion> {
  const heuristic = suggestMappingHeuristic(headers);
  const fallback = (): MappingSuggestion => ({
    mapping: heuristic,
    confidence: headers.length ? Object.values(heuristic).filter(Boolean).length / headers.length : 0,
    method: 'heuristic',
  });

  const anthropic = getClient();
  if (!anthropic || headers.length === 0 || headers.length > MAX_HEADERS) return fallback();

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JSON_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Headers:\n${JSON.stringify(headers)}` }],
    });
    if (response.stop_reason !== 'end_turn') {
      logger.warn('lead mapping: unexpected stop', { stopReason: response.stop_reason });
      return fallback();
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return fallback();

    // Keep only known headers, enforce one header per field, and let the
    // heuristic fill any header Claude left out.
    const used = new Set<LeadFieldKey>();
    const mapping: Record<string, LeadFieldKey | null> = {};
    for (const h of headers) {
      const v = parsed.data.mapping[h] ?? null;
      if (v && !used.has(v)) {
        mapping[h] = v;
        used.add(v);
      } else mapping[h] = null;
    }
    for (const h of headers) {
      const hv = heuristic[h];
      if (!mapping[h] && hv && !used.has(hv)) {
        mapping[h] = hv;
        used.add(hv);
      }
    }
    return { mapping, confidence: parsed.data.confidence, method: 'ai' };
  } catch (err) {
    const reason =
      err instanceof Anthropic.AuthenticationError
        ? 'auth'
        : err instanceof Anthropic.RateLimitError
          ? 'rate_limited'
          : err instanceof Anthropic.APIError
            ? `api_${err.status}`
            : err instanceof SyntaxError
              ? 'invalid_json'
              : 'error';
    logger.warn('lead mapping: falling back to heuristic', { reason });
    return fallback();
  }
}
