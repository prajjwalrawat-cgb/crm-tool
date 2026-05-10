import 'server-only';

import { incr, logger, setGauge } from '@/lib/observability';

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
    const isMissingKey =
      message.includes('INNGEST_EVENT_KEY') ||
      message.includes('event key') ||
      message.includes('Failed to send event');
    if (isMissingKey) {
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
