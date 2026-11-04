import 'server-only';

import OpenAI from 'openai';

/**
 * Models we ship with. Pinned here so a model change is one diff and
 * audit-traceable through the `ai_invocations.model` column.
 */
export const AI_MODELS = {
  embed: 'text-embedding-3-small',
  chat: 'gpt-4o-mini',
  summary: 'gpt-4o-mini',
} as const;

/** Vector dimensionality of `text-embedding-3-small`. Must match the column. */
export const EMBEDDING_DIMENSIONS = 1536;

let cached: OpenAI | undefined;

/**
 * Lazy-initialized singleton. We don't construct the client at module load
 * so the Next.js build doesn't fail when `OPENAI_API_KEY` is missing — only
 * the first AI call inside a server function will throw.
 */
export function getOpenAI(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to .env.local before invoking the AI layer.',
    );
  }
  cached = new OpenAI({ apiKey });
  return cached;
}
