import 'server-only';

import { captureError, incr, logger, setGauge } from '@/lib/observability';

import { inngest } from './client';
import type { WorkflowEventName, WorkflowEvents } from './events';
import { dispatchLocally } from './local-dispatcher';

/**
 * Force the workflow registry to be loaded so `dispatchLocally` has the
 * handlers registered before any event is dispatched. Importing the
 * barrel triggers `registerLocalHandler` calls at the top of
 * `workflows/index.ts`. Done lazily and once — outside of a function
 * to keep cold starts cheap and avoid handler dupes on hot reloads.
 */
let registrationsLoaded: Promise<unknown> | null = null;

function ensureHandlersRegistered(): Promise<unknown> {
  if (!registrationsLoaded) {
    registrationsLoaded = import('./workflows');
  }
  return registrationsLoaded;
}

/**
 * Type-safe wrapper around `inngest.send`. Lets us call:
 *
 *   await sendWorkflowEvent('crm/deal.stage_changed', { … })
 *
 * with the full payload type-checked against the registry. Wraps in
 * try/catch and *swallows* errors after logging — workflow-event delivery
 * is best-effort from the perspective of the originating mutation. The
 * mutation has already committed; failing the action because the
 * "side-effect" event couldn't be sent would be the wrong tradeoff.
 *
 * For atomic-send-with-mutation guarantees, we'd need a transactional
 * outbox table polled by a worker. Documented under future scaling.
 *
 * Failure-mode shaping:
 *   - When the local Inngest dev server isn't reachable AND no
 *     INNGEST_EVENT_KEY is configured, the SDK throws on every send. We
 *     detect that case once, log a clear setup hint, and from that point
 *     onward swallow events silently (with metric counter) until the
 *     situation changes. Otherwise the dev console gets dozens of
 *     identical "Failed to send event…" stack traces per CRUD action.
 */

let inngestUnreachableLogged = false;

export async function sendWorkflowEvent<TName extends WorkflowEventName>(
  name: TName,
  data: WorkflowEvents[TName],
): Promise<void> {
  try {
    // Inngest v4's send signature is structurally permissive without a
    // bound schema record on the client. Our outer generic gives us type
    // safety at every call site.
    await inngest.send({
      name,
      data,
    } as unknown as Parameters<typeof inngest.send>[0]);
    incr('inngest.send.success', 1, { name });
    setGauge('inngest.unreachable', 0);
  } catch (err) {
    incr('inngest.send.failure', 1, { name });
    const message = err instanceof Error ? err.message : String(err);
    if (isDeliveryUnavailable(message)) {
      markUnreachable(name);
      // Fire-and-forget: the originating mutation has committed and we
      // don't want a workflow failure to surface as a UI error. Errors
      // inside the dispatcher are captured via `captureError`.
      try {
        await ensureHandlersRegistered();
        await dispatchLocally(name, data);
        incr('inngest.local.dispatched', 1, { name });
      } catch (dispatchErr) {
        const dispatchMessage =
          dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
        logger.error('local dispatcher failed', {
          name,
          error: dispatchMessage,
        });
      }
      return;
    }
    // Genuine, unrelated send failure. Log once per occurrence — these are
    // rare and worth surfacing.
    logger.error(`inngest send failed: ${name}`, { error: message });
  }
}

/** The send errors that mean "no Inngest here" (dev without a dev server / event key): fall back to local dispatch. */
function isDeliveryUnavailable(message: string): boolean {
  return message.includes('INNGEST_EVENT_KEY') || message.includes('event key') || message.includes('Failed to send event');
}

function markUnreachable(name: string) {
  setGauge('inngest.unreachable', 1);
  if (!inngestUnreachableLogged) {
    inngestUnreachableLogged = true;
    logger.warn(
      'inngest event delivery unavailable — falling back to in-process local dispatcher. ' +
        'For production-grade durability/retries/sleep, run `pnpm inngest:dev` in a second terminal. ' +
        'Subsequent send failures are suppressed; check `inngest.send.failure` and `inngest.local.dispatched` on /dashboard/ops.',
      { firstFailedEvent: name },
    );
  }
}

/** Events per `inngest.send([...])` call. */
export const BATCH_SEND_CHUNK = 100;

/** Seams for selftests: the Inngest send and the local dispatcher. */
export type BatchSendOpts = {
  send?: (events: Array<{ name: string; data: unknown }>) => Promise<unknown>;
  dispatch?: typeof dispatchLocally;
};

/** One workflow event of any type, payload checked against its name. */
export type AnyWorkflowEvent = { [K in WorkflowEventName]: { name: K; data: WorkflowEvents[K] } }[WorkflowEventName];

/**
 * Many events of one type: one `inngest.send([...])` per BATCH_SEND_CHUNK
 * events. Never throws (same error handling as sendWorkflowEvent). On the
 * local fallback the handlers are started but NOT awaited, so the caller's
 * request never waits on workflow work (e.g. one Claude call per imported
 * prospect); handler errors are captured by the dispatcher / captureError.
 */
export async function sendWorkflowEventsBatch<TName extends WorkflowEventName>(
  name: TName,
  dataArray: Array<WorkflowEvents[TName]>,
  opts: BatchSendOpts = {},
): Promise<void> {
  await sendWorkflowEvents(dataArray.map((data) => ({ name, data }) as AnyWorkflowEvent), opts);
}

/** Count per event name, for the per-name metrics. */
function countByName(events: AnyWorkflowEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.name, (m.get(e.name) ?? 0) + 1);
  return m;
}

/**
 * Mixed events (any names): one `inngest.send([...])` per BATCH_SEND_CHUNK
 * events. Never throws. Same fallback as sendWorkflowEventsBatch: when Inngest
 * is unavailable the local handlers are started but not awaited.
 */
export async function sendWorkflowEvents(events: AnyWorkflowEvent[], opts: BatchSendOpts = {}): Promise<void> {
  const send =
    opts.send ?? ((evs: Array<{ name: string; data: unknown }>) => inngest.send(evs as unknown as Parameters<typeof inngest.send>[0]));
  for (let i = 0; i < events.length; i += BATCH_SEND_CHUNK) {
    const chunk = events.slice(i, i + BATCH_SEND_CHUNK);
    const counts = countByName(chunk);
    try {
      await send(chunk.map((e) => ({ name: e.name, data: e.data })));
      for (const [name, n] of counts) incr('inngest.send.success', n, { name });
      setGauge('inngest.unreachable', 0);
    } catch (err) {
      for (const [name, n] of counts) incr('inngest.send.failure', n, { name });
      const message = err instanceof Error ? err.message : String(err);
      const names = [...counts.keys()].join(',');
      if (!isDeliveryUnavailable(message)) {
        logger.error(`inngest batch send failed: ${names}`, { error: message, events: chunk.length });
        continue;
      }
      markUnreachable(chunk[0]!.name);
      const dispatch = opts.dispatch ?? dispatchLocally;
      const ready = opts.dispatch ? Promise.resolve() : ensureHandlersRegistered();
      for (const e of chunk) {
        // Fire-and-forget: never awaited by the caller.
        void ready
          .then(() => dispatch(e.name, e.data as never))
          .then(() => incr('inngest.local.dispatched', 1, { name: e.name }))
          .catch((dispatchErr) => captureError(dispatchErr, { category: 'inngest.local-dispatcher', severity: 'medium', retryable: false, fields: { event: e.name } }));
      }
    }
  }
}
