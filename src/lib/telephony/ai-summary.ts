import { z } from 'zod';

import { CALL_DISPOSITIONS, type CallAiSummary } from '@/db/schema/telephony';

/**
 * AI call summary: schema, prompt and validation. Pure (no SDK import), so
 * the selftest can check golden transcripts and the invalid-JSON path
 * without a network call. The Claude call itself lives in ai-summary-claude.ts.
 *
 * Grounding rules: the summary uses only what is in the transcript, never
 * invents numbers or dates, and says "unclear" when something is unclear.
 * A follow-up date the transcript does not support is dropped (see
 * `groundFollowUpDate`) rather than trusted.
 */

export const CALL_SUMMARY_MODEL = process.env.ANTHROPIC_CALL_SUMMARY_MODEL?.trim() || 'claude-sonnet-5-5';

export const callSummarySchema = z.object({
  summary: z.string().min(1).max(800),
  next_steps: z.array(z.string().min(1).max(300)).max(10),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  objections: z.array(z.string().min(1).max(300)).max(10),
  competitor_mentions: z.array(z.string().min(1).max(120)).max(10),
  suggested_disposition: z.enum([...CALL_DISPOSITIONS, 'unclear'] as [string, ...string[]]),
  follow_up_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

/** JSON schema sent as `output_config.format` (mirrors callSummarySchema). */
export const CALL_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'next_steps', 'sentiment', 'objections', 'competitor_mentions', 'suggested_disposition', 'follow_up_date'],
  properties: {
    summary: { type: 'string', description: 'At most 80 words.' },
    next_steps: { type: 'array', items: { type: 'string' } },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    objections: { type: 'array', items: { type: 'string' } },
    competitor_mentions: { type: 'array', items: { type: 'string' } },
    suggested_disposition: { type: 'string', enum: [...CALL_DISPOSITIONS, 'unclear'] },
    follow_up_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, only if the transcript states or clearly implies a specific date; otherwise null.' },
  },
} as const;

export const CALL_SUMMARY_SYSTEM = `You summarise B2B sales phone calls for a CRM. The transcript may be in English, Hindi or Hinglish; write the summary in English.

Rules:
- Use only what is said in the transcript. Do not add facts, names, prices, quantities or dates that are not in it.
- Never invent numbers or dates. If a figure or date is mentioned unclearly, write "unclear" instead of guessing.
- summary: at most 80 words, plain sentences.
- next_steps: concrete actions agreed or clearly needed, from the transcript. Empty if none.
- objections: concerns the customer raised. competitor_mentions: competitor company or product names actually said.
- suggested_disposition: the best fit from the allowed values, or "unclear".
- follow_up_date: a YYYY-MM-DD date only when the transcript names a specific day (a calendar date, or a relative day such as "tomorrow" or "next Monday" that you can resolve from the call date given). Otherwise null.`;

export function buildCallSummaryUserMessage(args: { transcript: string; callDate: Date; direction: 'outbound' | 'inbound' }): string {
  const day = args.callDate.toISOString().slice(0, 10);
  return `Call date: ${day} (${args.direction} call)\n\nTranscript:\n<transcript>\n${args.transcript}\n</transcript>`;
}

export type ParseResult = { ok: true; value: CallAiSummary } | { ok: false; error: string };

/** Parse + validate the model's JSON text. */
export function parseCallSummary(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const r = callSummarySchema.safeParse(json);
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  }
  const words = r.data.summary.trim().split(/\s+/).length;
  if (words > 80) return { ok: false, error: `summary has ${words} words; the limit is 80` };
  return { ok: true, value: r.data as CallAiSummary };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RELATIVE_DAY = /\b(today|tomorrow|kal|parso|day after|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)\b/i;

/**
 * Keep `follow_up_date` only if the transcript mentions a date or a relative
 * day at all. This is the backstop against a hallucinated follow-up date: a
 * transcript with no time reference cannot produce one.
 */
export function groundFollowUpDate(summary: CallAiSummary, transcript: string): CallAiSummary {
  if (!summary.follow_up_date) return summary;
  const t = transcript.toLowerCase();
  const [, m, d] = summary.follow_up_date.split('-').map(Number) as [number, number, number];
  const mentionsDay =
    RELATIVE_DAY.test(t) ||
    new RegExp(`\\b${d}(st|nd|rd|th)?\\b`).test(t) ||
    t.includes(MONTHS[m - 1] ?? '\u0000') ||
    /\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/.test(t);
  return mentionsDay ? summary : { ...summary, follow_up_date: null };
}
