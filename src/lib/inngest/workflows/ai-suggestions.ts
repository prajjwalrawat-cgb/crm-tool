import { runSuggestionsForCall, runSuggestionsForEmail, type ExtractDeps } from '@/lib/ai/suggestions/service';
import { runWithSystemContext } from '@/lib/db-context';
import { incr, runWithTrace } from '@/lib/observability';

import { callSummarizedEvent, emailThreadSummarizedEvent, inngest } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI } from '../local-step';

/**
 * AI field suggestions (0077):
 *   suggestions-from-call   crm/call.summarized          -> ai_suggestions
 *   suggestions-from-email  crm/email.thread_summarized  -> ai_suggestions
 *
 * Gated by organization_settings.ai_suggestions_enabled (default off).
 * Idempotent per source via ai_suggestion_sources. A retryable model error
 * throws INSIDE the step, so Inngest retries the step with backoff (a step
 * that returns normally is memoized and never re-run); the failed claim can
 * be re-taken.
 * Suggestions are only ever written to ai_suggestions; nothing touches deal
 * or contact fields.
 */

export async function suggestionsFromCallHandler(
  args: { event: { data: WorkflowEvents['crm/call.summarized'] }; step: LocalStepAPI },
  deps: ExtractDeps = {},
) {
  const { tenantId, callId } = args.event.data;
  return await runWithTrace({ origin: 'workflow', name: 'suggestions-from-call' }, async () => {
    const r = await args.step.run('extract', async () => {
      const res = await runWithSystemContext(tenantId, () => runSuggestionsForCall(tenantId, callId, deps));
      if (res.status === 'failed' && res.retryable) {
        incr('ai.suggestions.run', 1, { source: 'call', status: res.status });
        throw new Error(`suggestions-from-call: ${res.error}`);
      }
      return res;
    });
    incr('ai.suggestions.run', 1, { source: 'call', status: r.status });
    return r;
  });
}

export async function suggestionsFromEmailHandler(
  args: { event: { data: WorkflowEvents['crm/email.thread_summarized'] }; step: LocalStepAPI },
  deps: ExtractDeps = {},
) {
  const { tenantId, threadId } = args.event.data;
  return await runWithTrace({ origin: 'workflow', name: 'suggestions-from-email' }, async () => {
    const r = await args.step.run('extract', async () => {
      const res = await runWithSystemContext(tenantId, () => runSuggestionsForEmail(tenantId, threadId, deps));
      if (res.status === 'failed' && res.retryable) {
        incr('ai.suggestions.run', 1, { source: 'email', status: res.status });
        throw new Error(`suggestions-from-email: ${res.error}`);
      }
      return res;
    });
    incr('ai.suggestions.run', 1, { source: 'email', status: r.status });
    return r;
  });
}

export const suggestionsFromCall = inngest.createFunction(
  { id: 'suggestions-from-call', name: 'AI suggestions — from call', retries: 3, concurrency: { key: 'event.data.callId', limit: 1 }, triggers: [callSummarizedEvent] },
  async ({ event, step }) => suggestionsFromCallHandler({ event, step: step as unknown as LocalStepAPI }),
);

export const suggestionsFromEmail = inngest.createFunction(
  { id: 'suggestions-from-email', name: 'AI suggestions — from email', retries: 3, concurrency: { key: 'event.data.threadId', limit: 1 }, triggers: [emailThreadSummarizedEvent] },
  async ({ event, step }) => suggestionsFromEmailHandler({ event, step: step as unknown as LocalStepAPI }),
);
