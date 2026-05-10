import 'server-only';

import { logger } from '@/lib/observability';

/**
 * Minimal subset of Inngest's `step` API that our workflows actually
 * use. Inngest's real `step` object is structurally compatible — when
 * the workflow is dispatched via the cloud / dev server, Inngest passes
 * its full implementation in. When it's dispatched via the in-process
 * fallback (`local-dispatcher.ts`), we pass `localStep` instead.
 *
 * Why a local fallback exists at all: `pnpm dev` starts Next without
 * Inngest's dev server. Without it, every `inngest.send(...)` fails and
 * no workflow ever runs — events are emitted from server actions but
 * disappear into the void. To keep the dev experience self-contained we
 * route the same handler body through a stub that:
 *
 *   - `step.run`: just executes the function inline, no durability, no
 *     retries. Failures bubble up and are caught by the dispatcher.
 *   - `step.sleep`: skipped entirely with a one-line warning. Dev-mode
 *     fallback can't durably suspend a function over multiple days, so
 *     follow-up steps that come *after* a sleep run immediately. The
 *     deal-won workflow's 7-day follow-up note will fire right after
 *     the celebration note in dev — fine for testing the pipeline,
 *     wrong for actual product behavior. Production runs through real
 *     Inngest where `sleep` is durable.
 */
export type LocalStepAPI = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  sleep: (id: string, durationOrDate: string | Date) => Promise<void>;
};

/**
 * Where a workflow run was dispatched from. Stamped on each run row's
 * metadata so the workflows + ops pages can show "this ran via real
 * Inngest" vs "this ran via the in-process fallback (no retries, no
 * durable sleep)".
 */
export type WorkflowSource = 'inngest' | 'local';

let sleepWarningEmitted = false;

export const localStep: LocalStepAPI = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
  sleep: async (id: string) => {
    if (!sleepWarningEmitted) {
      sleepWarningEmitted = true;
      logger.warn(
        'workflow step.sleep skipped in local dispatcher (dev-only fallback). The follow-up step will run immediately. Start `pnpm inngest:dev` for durable scheduling.',
        { firstSkippedSleep: id },
      );
    }
    return Promise.resolve();
  },
};
