import 'server-only';

import Anthropic from '@anthropic-ai/sdk';

import { recordAiInvocation } from '@/lib/ai/audit';

import type { RiskPromptPayload } from './hash';

/**
 * THE "WHY" — one sentence per risky deal, written by Claude from the
 * bucketed signal payload.
 *
 * ---------------------------------------------------------------
 * THE MODEL WRITES THE PROSE; IT DOES NOT DECIDE THE SCORE
 * ---------------------------------------------------------------
 * The score is arithmetic (`./score`) and exists whether or not this module
 * ever runs. Claude turns the top factors into a sentence a human wants to
 * read. That division is what keeps the feature honest: nothing an LLM says
 * can move a number, and an outage or a missing API key costs the workspace
 * a nicer sentence, not its risk scoring — `deterministicExplanation` renders
 * instead.
 *
 * ---------------------------------------------------------------
 * THREE GUARDS AGAINST SPENDING AND AGAINST INVENTION
 * ---------------------------------------------------------------
 * 1. CACHE. Callers only reach this for a deal whose `signals_hash` changed,
 *    and that hash is the hash of the payload below — identical prompt,
 *    identical answer, no call. A stagnant deal is explained once per band
 *    change, not once per night and never once per page view.
 * 2. BUDGET. `MAX_EXPLANATIONS_PER_RUN` caps a single nightly run per tenant.
 *    The first run on a large workspace explains the riskiest deals and lets
 *    the rest arrive over subsequent nights rather than firing hundreds of
 *    calls at once.
 * 3. GROUNDING. Every number in the returned sentence must appear in the
 *    payload we sent. A sentence that invents "no activity in 12 days" — a
 *    figure the model was never given, because the payload speaks in bands —
 *    is rejected and the deterministic sentence is used. See
 *    `isGrounded`.
 */

/**
 * Deliberately the default rather than a cheaper model: this text is shown to
 * a sales leader as the reason a deal is flagged, and it is generated a few
 * times per deal per quarter, not per request. Override per deployment if
 * cost demands it.
 */
export const RISK_EXPLANATION_MODEL =
  process.env.ANTHROPIC_RISK_MODEL?.trim() || 'claude-opus-5';

/** Per-tenant ceiling for one nightly run. */
export const MAX_EXPLANATIONS_PER_RUN = 25;

/** Two short sentences; anything longer is not a summary. */
const MAX_TOKENS = 300;

const SYSTEM_PROMPT = [
  'You write one-line risk explanations for a B2B sales CRM.',
  '',
  'You are given a deal whose risk score was computed by a fixed rules-based',
  'formula — you are NOT scoring anything. Your only job is to turn the listed',
  'signals into a single sentence a sales manager can act on.',
  '',
  'Rules:',
  '- Name the two or three heaviest signals, in the order given.',
  '- Use ONLY the facts in the signal list. Never introduce a number, a date,',
  '  a person, a company or a cause that is not there. If a signal says "no',
  '  change in two to four weeks", do not convert that to a specific day count.',
  '- One sentence, at most two. No preamble, no "this deal", no advice, no',
  '  recommendations, no questions.',
  '- Plain past/present statements of fact, comma separated. Sentence case.',
  '',
  'Example input signals: ["close date pushed 2 times", "no change in two to',
  'four weeks", "3 required fields still empty at proposal stage"]',
  'Example output: Pushed twice, untouched for two to four weeks, and still',
  'missing 3 required fields at proposal stage.',
].join('\n');

let cachedClient: Anthropic | undefined;

/** True when a key is configured. Callers skip the explainer entirely when not. */
export function riskExplainerAvailable(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0;
}

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  // Constructed lazily so a build (or a workspace with no key) never fails at
  // module load — the same pattern `getOpenAI` uses for the other provider.
  cachedClient = new Anthropic();
  return cachedClient;
}

export type ExplanationResult = {
  text: string;
  model: string;
};

/**
 * Every digit run in `text` must also appear in the payload.
 *
 * The cheap, automatable half of "did it hallucinate a factor". The payload
 * speaks in bands precisely so that a specific figure in the output is
 * evidence of invention rather than of detail: the model was never told the
 * deal had been quiet for 19 days, so it cannot have known.
 *
 * Word-numbers ("twice", "two to four weeks") are expected and pass — those
 * come from the band phrases themselves.
 */
export function isGrounded(text: string, payload: RiskPromptPayload): boolean {
  const haystack = JSON.stringify(payload);
  const numbersInHaystack = new Set(haystack.match(/\d+/g) ?? []);
  for (const n of text.match(/\d+/g) ?? []) {
    if (!numbersInHaystack.has(n)) return false;
  }
  return true;
}

/** Collapse to a single line and trim the model's usual flourishes. */
function tidy(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

/**
 * Generate one explanation. Returns null on ANY failure — no key, an API
 * error, an empty or ungrounded answer — and the caller falls back to the
 * deterministic sentence. Failure is never thrown up into the nightly job,
 * because one bad sentence must not abort the scoring of a whole workspace.
 */
export async function explainRisk(input: {
  tenantId: string;
  dealId: string;
  payload: RiskPromptPayload;
}): Promise<ExplanationResult | null> {
  if (!riskExplainerAvailable()) return null;
  if (input.payload.signals.length === 0) return null;

  const startedAt = Date.now();
  const model = RISK_EXPLANATION_MODEL;

  try {
    const response = await getClient().messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // A one-sentence rewrite needs no deliberation. Thinking stays on
      // (Opus 5 defaults to adaptive, and disabling it has its own failure
      // modes); effort is what makes the call cheap.
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            stage: input.payload.stage,
            risk_score: input.payload.score,
            risk_band: input.payload.band,
            signals: input.payload.signals,
          }),
        },
      ],
    });

    const text = tidy(
      response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' '),
    );

    const grounded = text.length > 0 && isGrounded(text, input.payload);

    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: null,
      kind: 'summary',
      model,
      promptTokens: response.usage?.input_tokens ?? null,
      completionTokens: response.usage?.output_tokens ?? null,
      totalTokens:
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.output_tokens ?? 0),
      latencyMs: Date.now() - startedAt,
      status: grounded ? 'success' : 'error',
      error: grounded
        ? null
        : text.length === 0
          ? 'empty explanation'
          : 'ungrounded explanation (number not present in payload)',
      metadata: { feature: 'deal_risk_explanation', dealId: input.dealId },
    });

    if (!grounded) return null;
    return { text, model };
  } catch (err) {
    // Typed, most-specific-first: a bad key is a configuration problem worth
    // seeing in the audit log distinctly from a rate limit, which is a
    // transient one the next nightly run will clear on its own.
    const message =
      err instanceof Anthropic.AuthenticationError
        ? 'anthropic auth failed (check ANTHROPIC_API_KEY)'
        : err instanceof Anthropic.RateLimitError
          ? 'anthropic rate limited'
          : err instanceof Anthropic.APIError
            ? `anthropic api error ${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);

    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: null,
      kind: 'summary',
      model,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      error: message,
      metadata: { feature: 'deal_risk_explanation', dealId: input.dealId },
    }).catch(() => {
      /* the audit write must never mask the original failure */
    });
    return null;
  }
}
