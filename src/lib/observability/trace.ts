import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Lightweight in-process trace context. Goal: a single user action — a
 * server action, the workflow it triggers, and the SSE/realtime broadcasts
 * it produces — share one trace id end-to-end so logs and audit rows can
 * be correlated without an external trace backend.
 *
 * Not OpenTelemetry. Not a remote sampler. Just `traceId` + `spanId`
 * propagated through AsyncLocalStorage, so any helper that wants to log
 * or record metrics can pull the current ids without plumbing them
 * through every signature.
 *
 * Lifecycle:
 *   1. Boundary code (`/api/ai/chat`, an Inngest function, a server
 *      action) calls `runWithTrace({ origin })`. A fresh `traceId` is
 *      minted; it's the root span's id.
 *   2. Inside that body, `withSpan('name', fn)` opens a child span. The
 *      span auto-records its duration to metrics.
 *   3. Cross-process hops (Inngest events, NOTIFY payloads) carry the
 *      trace id in their metadata so the receiver can re-enter the same
 *      trace via `runWithTrace({ traceId })`.
 */

export type TraceOrigin =
  | 'server-action'
  | 'http'
  | 'sse'
  | 'workflow'
  | 'cron'
  | 'webhook'
  | 'system';

export type TraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  origin: TraceOrigin;
  /** Optional human-readable name for the root operation. */
  name?: string;
  /** Wall-clock at trace start (ms). */
  startedAt: number;
};

const store = new AsyncLocalStorage<TraceContext>();

function shortId(): string {
  return randomBytes(8).toString('hex');
}

export function newTraceId(): string {
  return randomUUID();
}

export function getTraceContext(): TraceContext | undefined {
  return store.getStore();
}

export function currentTraceId(): string | undefined {
  return store.getStore()?.traceId;
}

export function currentSpanId(): string | undefined {
  return store.getStore()?.spanId;
}

export type RunWithTraceInput = {
  origin: TraceOrigin;
  /**
   * Continue an existing trace (cross-process). When omitted, a fresh
   * `traceId` is minted.
   */
  traceId?: string;
  parentSpanId?: string;
  name?: string;
};

/**
 * Enter a fresh trace context for the duration of `fn`. Nested calls to
 * `runWithTrace` will *not* shadow this one — use `withSpan` for child
 * spans inside the same trace.
 */
export async function runWithTrace<T>(
  input: RunWithTraceInput,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: TraceContext = {
    traceId: input.traceId ?? newTraceId(),
    spanId: shortId(),
    parentSpanId: input.parentSpanId,
    origin: input.origin,
    name: input.name,
    startedAt: Date.now(),
  };
  return await store.run(ctx, fn);
}

/**
 * Open a child span inside the current trace. Records the span's
 * duration to the metrics module under `span.<name>.duration_ms` so
 * the ops dashboard can show latency by operation without per-call
 * boilerplate.
 *
 * Falls back to a standalone trace if no parent context is set — this
 * avoids cascading failures when an unwrapped helper accidentally calls
 * `withSpan`. The fallback is silent; we don't throw on missing context
 * because it would degrade observability into a hard dependency.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = store.getStore();
  if (!parent) {
    // No trace context — run inside a fresh one so child helpers that
    // depend on `getTraceContext()` still work.
    return await runWithTrace(
      { origin: 'system', name: `orphan:${name}` },
      () => runSpan(name, fn),
    );
  }
  const childCtx: TraceContext = {
    traceId: parent.traceId,
    spanId: shortId(),
    parentSpanId: parent.spanId,
    origin: parent.origin,
    name,
    startedAt: Date.now(),
  };
  return await store.run(childCtx, () => runSpan(name, fn));
}

async function runSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    // Lazy import to avoid a hard cycle: metrics imports nothing from
    // trace, but a future revision might log inside metrics — and we
    // never want the import graph to be load-order-sensitive.
    const { recordSpan } = await import('./metrics');
    recordSpan(name, Date.now() - startedAt);
  }
}
