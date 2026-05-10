import 'server-only';

import { randomUUID } from 'node:crypto';

import { captureError, logger } from '@/lib/observability';

import type { WorkflowEventName, WorkflowEvents } from './events';
import { localStep, type WorkflowSource } from './local-step';

/**
 * In-process workflow dispatcher.
 *
 * Lifecycle:
 *   - `sendWorkflowEvent` first tries to deliver via `inngest.send`.
 *   - When that fails because the local Inngest dev server isn't
 *     running and no `INNGEST_EVENT_KEY` is configured, the dispatcher
 *     here is invoked as a fire-and-forget fallback.
 *   - The dispatcher looks up handler functions registered against the
 *     event name and runs each of them with `localStep` (a stub that
 *     skips `step.sleep` and runs `step.run` inline). Workflows record
 *     their own runs to `workflow_runs` and metrics to the in-process
 *     observability layer, so the workflows page and ops dashboard
 *     stay populated even when Inngest is offline.
 *
 * NOT a substitute for Inngest in production:
 *   - No retries.
 *   - No durability — a process restart drops in-flight handlers.
 *   - `step.sleep` is a no-op so multi-day delays collapse to zero.
 *   - Fire-and-forget: errors are captured but don't propagate to the
 *     originating mutation, since that mutation has already committed.
 */

type Handler<T extends WorkflowEventName> = (args: {
  event: { data: WorkflowEvents[T] };
  step: typeof localStep;
  runId: string;
  source: WorkflowSource;
}) => Promise<unknown>;

const handlers = new Map<WorkflowEventName, Handler<WorkflowEventName>[]>();

export function registerLocalHandler<T extends WorkflowEventName>(
  name: T,
  handler: Handler<T>,
): void {
  const list = handlers.get(name) ?? [];
  list.push(handler as Handler<WorkflowEventName>);
  handlers.set(name, list);
}

/**
 * Returns the handler-name list for a given event. Used by tests +
 * the ops dashboard for visibility.
 */
export function getRegisteredEventNames(): WorkflowEventName[] {
  return Array.from(handlers.keys());
}

/**
 * Run every handler registered for `name` against the provided event
 * data. Any handler error is captured to the observability layer but
 * doesn't propagate — the originating mutation has already committed
 * and we don't want a workflow failure to surface as a UI error.
 */
export async function dispatchLocally<T extends WorkflowEventName>(
  name: T,
  data: WorkflowEvents[T],
): Promise<void> {
  const list = handlers.get(name);
  if (!list || list.length === 0) return;
  const runId = `local-${randomUUID()}`;
  await Promise.allSettled(
    list.map(async (handler) => {
      try {
        await handler({
          event: { data: data as WorkflowEvents[WorkflowEventName] },
          step: localStep,
          runId,
          source: 'local',
        });
      } catch (err) {
        captureError(err, {
          category: 'inngest.local-dispatcher',
          severity: 'high',
          retryable: false,
          fields: { event: name, runId },
        });
      }
    }),
  );
  logger.debug('local-dispatcher fan-out complete', {
    event: name,
    handlers: list.length,
    runId,
  });
}
