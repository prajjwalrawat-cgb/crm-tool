import 'server-only';

/**
 * AI feature-flag plumbing.
 *
 * Three-state mode:
 *   - `live`     : `AI_ENABLED=true` AND a non-empty `OPENAI_API_KEY` is set.
 *   - `mock`     : `AI_ENABLED=false` (or unset). Deterministic in-process
 *                  responses; no network, no token cost. The full retrieval
 *                  pipeline still executes — only the model calls are stubbed.
 *   - `disabled` : `AI_ENABLED=true` but no key. Treated like `mock` at the
 *                  call site to avoid throwing, but the ops dashboard surfaces
 *                  it as a misconfiguration.
 *
 * The split exists so `ops/` can show *why* AI is mocked: deliberate (`mock`)
 * vs misconfigured (`disabled`).
 */
export type AIMode = 'live' | 'mock' | 'disabled';

function readBool(name: string): boolean {
  const raw = process.env[name];
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export function getAIMode(): AIMode {
  const enabled = readBool('AI_ENABLED');
  const hasKey = (process.env.OPENAI_API_KEY ?? '').trim().length > 0;
  if (!enabled) return 'mock';
  return hasKey ? 'live' : 'disabled';
}

/** Live mode = "make actual OpenAI calls." Anything else uses mocks. */
export function aiLive(): boolean {
  return getAIMode() === 'live';
}

/**
 * Master switch for user-facing AI *feature surfaces* (the deal-detail
 * AI Summary / AI Deal Analysis cards). Defaults to OFF: until the AI
 * backend is genuinely wired for a workspace we hide these cards entirely
 * rather than render a visibly fake "generating"/"mock" state in front of
 * a client. Flip `AI_FEATURES_ENABLED=true` once the cards return real,
 * model-backed output.
 *
 * This is intentionally separate from `getAIMode()` (which governs the
 * retrieval/copilot plumbing): a workspace can run the copilot in mock
 * mode for internal dev while keeping the customer-facing deal AI cards
 * hidden.
 */
export function aiFeaturesEnabled(): boolean {
  return readBool('AI_FEATURES_ENABLED');
}

/** A short label suitable for logs and audit metadata. */
export function aiModeLabel(): string {
  return getAIMode();
}
