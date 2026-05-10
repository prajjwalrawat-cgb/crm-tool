import 'server-only';

import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

import { recordAiInvocation } from './audit';
import { aiLive, aiModeLabel } from './config';
import {
  approxTokens,
  buildMockAnswer,
  mockStreamAnswer,
} from './mock';
import { AI_MODELS, getOpenAI } from './openai';

function lastUserPrompt(messages: ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** Sum prompt characters for the audit prompt-token estimate in mock mode. */
function totalPromptChars(messages: ChatCompletionMessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length;
  }
  return n;
}

/**
 * Count `Record #` markers in the system prompt — that's how
 * `buildSystemPrompt` enumerates retrieved CRM records. Used by the
 * mock chat to surface "the retrieval layer ran" in its canned answer.
 */
function countRetrievedRecords(messages: ChatCompletionMessageParam[]): number {
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string') {
      const matches = m.content.match(/Record #\d+/g);
      return matches ? matches.length : 0;
    }
  }
  return 0;
}

/**
 * One-shot (non-streaming) chat completion. Used by deal/company summaries
 * where we don't need token-by-token UI — just the final string and the
 * usage numbers for billing.
 *
 * Every call is audited via `recordAiInvocation`. We pass `user: tenantId`
 * to OpenAI for per-tenant abuse correlation rather than the actor's user
 * id, matching the embedding helper.
 */
export type CompleteInput = {
  tenantId: string;
  actorUserId: string | null;
  /** Audit kind — `'summary'` for entity summaries, `'chat'` for copilot. */
  kind: 'chat' | 'summary';
  /** Override the default model. Default = `AI_MODELS.summary`. */
  model?: string;
  messages: ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
};

export type CompleteResult = {
  content: string;
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
};

export async function complete(input: CompleteInput): Promise<CompleteResult> {
  const startedAt = Date.now();
  const model = input.model ?? AI_MODELS.summary;
  const mode = aiModeLabel();

  if (!aiLive()) {
    const prompt = lastUserPrompt(input.messages);
    const recordCount = countRetrievedRecords(input.messages);
    const content = buildMockAnswer({
      prompt,
      contextRecordCount: recordCount,
      shape: input.kind === 'summary' ? 'summary' : 'chat',
    });
    const promptTokens = approxTokens(
      input.messages
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n'),
    );
    const completionTokens = approxTokens(content);
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      latencyMs: Date.now() - startedAt,
      status: 'skipped',
      metadata: { ...input.metadata, mode, mock: true },
    });
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  try {
    const response: ChatCompletion = await getOpenAI().chat.completions.create({
      model,
      messages: input.messages,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens,
      user: input.tenantId,
    });
    const content = response.choices[0]?.message?.content ?? '';
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      model,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      latencyMs: Date.now() - startedAt,
      status: 'success',
      metadata: { ...input.metadata, mode },
    });
    return {
      content,
      totalTokens: response.usage?.total_tokens ?? null,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      model,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      error: message,
      metadata: { ...input.metadata, mode },
    });
    throw err;
  }
}

/* -------- Streaming -------- */

/**
 * Streaming chat completion. Yields plain string deltas — the route handler
 * encodes them as SSE frames. We intentionally don't expose raw OpenAI
 * chunks to keep the wire protocol decoupled from the SDK.
 *
 * Audit happens once at the end (success) or once on error. We track usage
 * locally because the streaming response only carries token counts on the
 * final chunk when `stream_options.include_usage` is enabled.
 */
export type StreamInput = Omit<CompleteInput, 'kind'> & {
  kind?: 'chat';
};

export type StreamResult = {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export async function* streamComplete(
  input: StreamInput,
): AsyncGenerator<string, StreamResult, void> {
  const startedAt = Date.now();
  const model = input.model ?? AI_MODELS.chat;
  const mode = aiModeLabel();

  let accumulated = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;

  if (!aiLive()) {
    const prompt = lastUserPrompt(input.messages);
    const recordCount = countRetrievedRecords(input.messages);
    const fullText = buildMockAnswer({
      prompt,
      contextRecordCount: recordCount,
      shape: 'chat',
    });
    promptTokens = approxTokens(
      input.messages
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n'),
    );

    for await (const chunk of mockStreamAnswer(fullText)) {
      accumulated += chunk;
      yield chunk;
    }
    completionTokens = approxTokens(accumulated);
    totalTokens = promptTokens + completionTokens;

    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'chat',
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs: Date.now() - startedAt,
      status: 'skipped',
      metadata: {
        ...input.metadata,
        mode,
        mock: true,
        promptChars: totalPromptChars(input.messages),
      },
    });
    return { text: accumulated, promptTokens, completionTokens, totalTokens };
  }

  try {
    const stream = await getOpenAI().chat.completions.create({
      model,
      messages: input.messages,
      temperature: input.temperature ?? 0.3,
      max_tokens: input.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      user: input.tenantId,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        accumulated += delta;
        yield delta;
      }
      // The final chunk (after `[DONE]`) carries usage when include_usage:true.
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? null;
        completionTokens = chunk.usage.completion_tokens ?? null;
        totalTokens = chunk.usage.total_tokens ?? null;
      }
    }

    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'chat',
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs: Date.now() - startedAt,
      status: 'success',
      metadata: { ...input.metadata, mode },
    });

    return {
      text: accumulated,
      promptTokens,
      completionTokens,
      totalTokens,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'chat',
      model,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      error: message,
      metadata: { ...input.metadata, mode },
    });
    throw err;
  }
}
