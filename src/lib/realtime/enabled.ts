/**
 * Master switch for the realtime layer (SSE stream + the ephemeral
 * viewing/typing publishes that feed it).
 *
 * WHY THIS EXISTS
 * The SSE endpoint is a relay: it opens a Postgres LISTEN, then holds the
 * HTTP response open for as long as the browser tab lives, forwarding
 * NOTIFYs as they arrive. It does almost no work — production measured
 * 506 GB-Hrs of provisioned memory against 4h15m of CPU, under 2%
 * utilisation — but Vercel bills provisioned *duration*, so an idle relay
 * costs the same as a busy one. It was ~all of the Fluid bill and put the
 * project over its plan allowance.
 *
 * Turning this off makes every request short-lived again: nothing holds an
 * instance open, and the GB-Hours cost of realtime goes to roughly zero.
 * The app stays fully usable — data refreshes on navigation instead of
 * pushing itself. What's lost while off: cross-user live updates, the
 * presence indicator, typing indicators, and the live activity feed.
 *
 * DEFAULTS OFF. This is a cost guard, so absence of the flag must mean
 * "don't hold connections open" rather than the reverse — an unset variable
 * on a new environment should not silently start billing.
 *
 * NEXT_PUBLIC_ is required, not incidental: the CLIENT is what must decide
 * not to connect. If only the server refused, EventSource would keep
 * retrying and trade one long invocation for a storm of short ones — worse
 * on invocation count and no better on duration. The server-side guard in
 * the route is defence in depth for that case, not the primary mechanism.
 *
 * Read through this function rather than caching the result in a module
 * constant, so tests can toggle the environment between calls.
 */
export function realtimeEnabled(): boolean {
  // Must be referenced as a full literal — Next inlines NEXT_PUBLIC_* vars
  // into the client bundle by exact textual match, so `process.env[name]`
  // through a helper would silently read undefined in the browser.
  const raw = process.env.NEXT_PUBLIC_REALTIME_ENABLED;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}
