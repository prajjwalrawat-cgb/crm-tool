import 'server-only';

import Anthropic from '@anthropic-ai/sdk';

import type { CallAiSummary } from '@/db/schema/telephony';

import {
  buildCallSummaryUserMessage,
  CALL_SUMMARY_JSON_SCHEMA,
  CALL_SUMMARY_MODEL,
  CALL_SUMMARY_SYSTEM,
  groundFollowUpDate,
  parseCallSummary,
} from './ai-summary';

/**
 * Claude call for the AI call summary. Structured output (json_schema) keeps
 * the reply parseable; zod validates it anyway, and on an invalid reply we
 * retry ONCE with the validation error. If the retry also fails the caller
 * stores the transcript only.
 *
 * Only the transcript text and the call date/direction are sent: no names,
 * phone numbers or CRM fields.
 */

let client: Anthropic | undefined;
export function claudeConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0;
}
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export type SummaryUsage = { inputTokens: number; outputTokens: number; latencyMs: number; model: string };

export type SummarizeOutcome =
  | { ok: true; summary: CallAiSummary; attempts: number; usage: SummaryUsage }
  | { ok: false; error: string; attempts: number; usage: SummaryUsage };

export async function summarizeCallTranscript(args: {
  transcript: string;
  callDate: Date;
  direction: 'outbound' | 'inbound';
  /** Injected in tests. */
  create?: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
}): Promise<SummarizeOutcome> {
  const create = args.create ?? ((p) => getClient().messages.create(p));
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildCallSummaryUserMessage(args) },
  ];
  let lastError = 'no response';
  const usage: SummaryUsage = { inputTokens: 0, outputTokens: 0, latencyMs: 0, model: CALL_SUMMARY_MODEL };
  const t0 = Date.now();
  const done = () => ({ ...usage, latencyMs: Date.now() - t0 });
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response: Anthropic.Message;
    try {
      response = await create({
        model: CALL_SUMMARY_MODEL,
        max_tokens: 2000,
        system: CALL_SUMMARY_SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: CALL_SUMMARY_JSON_SCHEMA as unknown as Record<string, unknown> } },
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        // Transient: let the workflow's retry handle it.
        throw err;
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err), attempts: attempt, usage: done() };
    }
    usage.inputTokens += response.usage?.input_tokens ?? 0;
    usage.outputTokens += response.usage?.output_tokens ?? 0;
    if (response.stop_reason === 'refusal') {
      return { ok: false, error: 'model declined to summarise this call', attempts: attempt, usage: done() };
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const parsed = parseCallSummary(text);
    if (parsed.ok) {
      return { ok: true, summary: groundFollowUpDate(parsed.value, args.transcript), attempts: attempt, usage: done() };
    }
    lastError = parsed.error;
    messages.push(
      { role: 'assistant', content: text || '(empty)' },
      { role: 'user', content: `That reply did not validate: ${parsed.error}. Reply again with only the corrected JSON object.` },
    );
  }
  return { ok: false, error: lastError, attempts: 2, usage: done() };
}
