import 'server-only';

import { createHash } from 'node:crypto';

import { EMBEDDING_DIMENSIONS } from './openai';

/**
 * Deterministic AI mocks. All functions here are pure-CPU — no network,
 * no I/O, no randomness. Same input → same output forever.
 *
 * The point isn't to imitate model quality; it's to keep every code path
 * (embedding upsert, vector search, copilot streaming, summary cache)
 * exercised when AI is disabled, so we catch wiring bugs in development
 * and in deploys without an OpenAI key.
 */

/* ---------------- Mock embeddings ---------------- */

/**
 * Seedable PRNG (mulberry32). 32-bit state, fast, deterministic. We only
 * need stability + spread; cryptographic randomness is irrelevant for a
 * mock embedding.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic 1536-d embedding for `content`. We seed mulberry32 from
 * the first 4 bytes of `sha256(content)` so different contents produce
 * different vectors, and the same content always produces the same one.
 *
 * The vector is L2-normalized so cosine distance behaves sanely against
 * any other mock embedding produced the same way.
 */
export function mockEmbedding(content: string): number[] {
  const hash = createHash('sha256').update(content).digest();
  const seed = hash.readUInt32BE(0);
  const rand = mulberry32(seed);

  const v = new Array<number>(EMBEDDING_DIMENSIONS);
  let sumSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    // map [0,1) → [-1, 1)
    const x = rand() * 2 - 1;
    v[i] = x;
    sumSq += x * x;
  }
  const inv = 1 / Math.sqrt(sumSq || 1);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    v[i] = v[i]! * inv;
  }
  return v;
}

/* ---------------- Mock chat / summary completions ---------------- */

export type MockCompletionInput = {
  /** The user-visible question (chat) or instruction (summary). */
  prompt: string;
  /**
   * Number of records the retrieval pipeline surfaced for this turn.
   * Surfaced in the mock answer so devs can verify retrieval ran.
   */
  contextRecordCount: number;
  /** What the answer should look like — chat gets a longer template. */
  shape: 'chat' | 'summary';
};

const MOCK_NOTICE =
  'AI is currently running in mock mode (AI_ENABLED=false). The retrieval pipeline ran end-to-end and the citations above are real CRM records, but this answer text is a deterministic stub.';

/**
 * Generate a canned answer string. Long enough to make streaming feel
 * realistic in the UI; short enough to not dominate the panel.
 */
export function buildMockAnswer(input: MockCompletionInput): string {
  if (input.shape === 'summary') {
    return `${MOCK_NOTICE} Once OPENAI_API_KEY is set and AI_ENABLED=true, this card will show a real model-generated 2–4 sentence summary of the deal's state, momentum, and any open signals from recent activity.`;
  }
  // chat
  return `${MOCK_NOTICE} The retrieval layer surfaced ${input.contextRecordCount} matching record${input.contextRecordCount === 1 ? '' : 's'} from your tenant — see the citations chips above. With live AI, the model would weigh those records against your question ("${input.prompt.slice(0, 80)}${input.prompt.length > 80 ? '…' : ''}") and answer in 1–3 paragraphs grounded only in that context.`;
}

/**
 * Estimate token count without an OpenAI tokenizer dependency. We use
 * the standard ~4 chars/token approximation. Good enough for ops-level
 * intent ("would this prompt have cost ~3k tokens?"), not billing.
 */
export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Async generator that streams a string chunked into ~3-word frames at
 * a configurable cadence. Mirrors what live OpenAI streaming feels like
 * so the SSE wire protocol stays exercised in mock mode.
 */
export async function* mockStreamAnswer(
  text: string,
  options: { chunkSize?: number; delayMs?: number } = {},
): AsyncGenerator<string, void, void> {
  const chunkSize = options.chunkSize ?? 18;
  const delayMs = options.delayMs ?? 25;
  for (let i = 0; i < text.length; i += chunkSize) {
    const piece = text.slice(i, i + chunkSize);
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    yield piece;
  }
}
