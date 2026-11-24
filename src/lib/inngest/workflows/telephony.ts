import { cron } from 'inngest';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { calls, tenants, type CallStatus, type TelephonyProviderName } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { captureError, incr, runWithTrace } from '@/lib/observability';
import { getAccountRow, getTelephonySettings, toAccountContext } from '@/lib/telephony/accounts';
import { claudeConfigured, summarizeCallTranscript } from '@/lib/telephony/ai-summary-claude';
import { runDialerTick } from '@/lib/telephony/campaigns';
import { getProvider } from '@/lib/telephony/providers';
import { processCallEvent } from '@/lib/telephony/service';
import { recordAiInvocation } from '@/lib/ai/audit';
import { recordFollowUpSuggestion } from '@/lib/ai/suggestions/service';
import { uploadRecording } from '@/lib/telephony/storage';
import {
  attemptTranscription,
  markTranscriptionFailed,
  prepareTranscription,
  type TranscribeDeps,
} from '@/lib/telephony/transcription';

import {
  callCompletedEvent,
  callEventReceivedEvent,
  callRecordingArchivedEvent,
  callTranscribedEvent,
  callTranscribeRequestedEvent,
  inngest,
} from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI } from '../local-step';
import { sendWorkflowEvent } from '../send';
import { eachTenant } from './each-tenant';

/**
 * Telephony workflows (build prompt 2):
 *   call-event-process     crm/call.event_received → upsert call, side effects
 *   call-recording-archive crm/call.completed → copy recording to our storage
 *   call-transcribe        crm/call.recording_archived | crm/call.transcribe_requested → speech-to-text
 *   call-ai-summarize      crm/call.transcribed → Claude summary → crm/call.summarized
 *   campaign-dialer-tick   every 15 min → stale claims, completed campaigns
 */

const toDate = (s: string | null) => (s ? new Date(s) : null);

export async function callEventProcessHandler(args: { event: { data: WorkflowEvents['crm/call.event_received'] }; step: LocalStepAPI }) {
  const { tenantId, accountId, provider, event } = args.event.data;
  return await runWithTrace({ origin: 'workflow', name: 'call-event-process' }, async () => {
    const out = await args.step.run('process', () =>
      runWithSystemContext(tenantId, () =>
        processCallEvent({
          tenantId,
          accountId,
          provider: provider as TelephonyProviderName,
          event: {
            ...event,
            status: event.status as CallStatus,
            startedAt: toDate(event.startedAt),
            answeredAt: toDate(event.answeredAt),
            endedAt: toDate(event.endedAt),
          },
        }),
      ),
    );
    incr('telephony.event.processed', 1, { terminal: String(out.becameTerminal) });
    // A recording URL can arrive on the terminal event or on a late duplicate.
    if (out.hasRecordingUrl) {
      await args.step.run('emit-completed', () => sendWorkflowEvent('crm/call.completed', { tenantId, callId: out.callId }));
    }
    return out;
  });
}

export const callEventProcess = inngest.createFunction(
  {
    id: 'call-event-process',
    name: 'Telephony — process provider webhook',
    retries: 5,
    // Webhooks for one call are applied one at a time (order-independent anyway).
    concurrency: { key: 'event.data.event.providerCallId', limit: 1 },
    triggers: [callEventReceivedEvent],
  },
  async ({ event, step }) => callEventProcessHandler({ event, step: step as unknown as LocalStepAPI }),
);

/** Backoff for a recording that isn't ready yet: ~30 minutes in total. */
const RECORDING_BACKOFF = ['1m', '2m', '4m', '8m', '15m'];

export async function callRecordingArchiveHandler(args: { event: { data: WorkflowEvents['crm/call.completed'] }; step: LocalStepAPI }) {
  const { tenantId, callId } = args.event.data;
  for (let attempt = 0; attempt <= RECORDING_BACKOFF.length; attempt++) {
    const result = await args.step.run(`archive-${attempt}`, () =>
      runWithSystemContext(tenantId, async () => {
        const call = await tenantTransaction(async (tx) => {
          const [c] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId)));
          return c ?? null;
        });
        if (!call) return { status: 'gone' as const };
        if (call.recordingStorageKey) return { status: 'done' as const };
        if (!call.recordingUrl || !call.accountId) return { status: 'no-url' as const };
        const accountRow = await tenantTransaction((tx) => getAccountRow(tx, tenantId, call.accountId!));
        if (!accountRow) return { status: 'no-account' as const };
        const account = toAccountContext(accountRow);
        const provider = getProvider(account.provider);
        if (!provider.fetchRecording) return { status: 'unsupported' as const };
        try {
          const { body, contentType } = await provider.fetchRecording(call.recordingUrl, account);
          const bytes = new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer());
          if (bytes.byteLength === 0) return { status: 'retry' as const };
          const key = await uploadRecording({ tenantId, callId, bytes, contentType });
          await tenantTransaction((tx) =>
            tx.update(calls).set({ recordingStorageKey: key, recordingArchivedAt: new Date() }).where(eq(calls.id, callId)),
          );
          return { status: 'archived' as const };
        } catch (err) {
          captureError(err, { category: 'telephony.recording-archive', retryable: true, fields: { callId } });
          return { status: 'retry' as const };
        }
      }),
    );
    if (result.status === 'archived') {
      await args.step.run('emit-archived', () => sendWorkflowEvent('crm/call.recording_archived', { tenantId, callId }));
      return result;
    }
    if (result.status !== 'retry') return result;
    const wait = RECORDING_BACKOFF[attempt];
    if (!wait) break;
    await args.step.sleep(`wait-${attempt}`, wait);
  }
  return { status: 'gave-up' as const };
}

export const callRecordingArchive = inngest.createFunction(
  {
    id: 'call-recording-archive',
    name: 'Telephony — archive call recording',
    retries: 3,
    idempotency: 'event.data.callId',
    triggers: [callCompletedEvent],
  },
  async ({ event, step }) => callRecordingArchiveHandler({ event, step: step as unknown as LocalStepAPI }),
);

/** Backoff between transcription attempts (retryable provider errors only). */
const TRANSCRIBE_BACKOFF = ['30s', '2m', '5m'];

type TranscribeEventData = { tenantId: string; callId: string; requestedBy?: string };

/**
 * Speech-to-text on an archived recording, then `crm/call.transcribed`.
 * Triggered by the archive (crm/call.recording_archived) and by a user's
 * Retry (crm/call.transcribe_requested). Idempotency lives in the DB claim
 * (lib/telephony/transcription.ts), so duplicates and retries are safe.
 */
export async function callTranscribeHandler(
  args: { event: { data: TranscribeEventData }; step: LocalStepAPI },
  deps: TranscribeDeps = {},
) {
  const { tenantId, callId } = args.event.data;
  const requestedBy = args.event.data.requestedBy ?? null;
  return await runWithTrace({ origin: 'workflow', name: 'call-transcribe' }, async () => {
    const prep = await args.step.run('prepare', () => runWithSystemContext(tenantId, () => prepareTranscription(tenantId, callId, deps)));
    if (prep.status !== 'claimed') return prep;
    let lastError = 'unknown error';
    for (let attempt = 0; attempt <= TRANSCRIBE_BACKOFF.length; attempt++) {
      const r = await args.step.run(`transcribe-${attempt}`, () =>
        runWithSystemContext(tenantId, () => attemptTranscription(tenantId, callId, { ...deps, requestedBy, provider: prep.provider })),
      );
      if (r.kind === 'done') {
        await args.step.run('emit-transcribed', () => sendWorkflowEvent('crm/call.transcribed', { tenantId, callId }));
        return { status: 'done' as const, segments: r.segments, attempts: attempt + 1 };
      }
      lastError = r.error;
      if (r.kind === 'fail') break;
      const wait = TRANSCRIBE_BACKOFF[attempt];
      if (!wait) break;
      await args.step.sleep(`transcribe-wait-${attempt}`, wait);
    }
    await args.step.run('mark-failed', () => runWithSystemContext(tenantId, () => markTranscriptionFailed(tenantId, callId, lastError)));
    return { status: 'failed' as const, error: lastError };
  });
}

export const callTranscribe = inngest.createFunction(
  {
    id: 'call-transcribe',
    name: 'Telephony — transcribe call recording',
    retries: 2,
    // One transcription per call at a time; the DB claim makes repeats no-ops.
    concurrency: { key: 'event.data.callId', limit: 1 },
    triggers: [callRecordingArchivedEvent, callTranscribeRequestedEvent],
  },
  async ({ event, step }) =>
    callTranscribeHandler({ event: event as unknown as { data: TranscribeEventData }, step: step as unknown as LocalStepAPI }),
);

/** AI summary needs this much talk time to be worth a call to Claude. */
const MIN_TALK_SEC = 45;

export async function callAiSummarizeHandler(args: {
  event: { data: WorkflowEvents['crm/call.transcribed'] };
  step: LocalStepAPI;
  /** Injected in tests. */
  summarize?: typeof summarizeCallTranscript;
}) {
  const { tenantId, callId } = args.event.data;
  const summarize = args.summarize ?? summarizeCallTranscript;
  return await args.step.run('summarize', () =>
    runWithSystemContext(tenantId, async () => {
      const ctx = await tenantTransaction(async (tx) => {
        const settings = await getTelephonySettings(tx, tenantId);
        const [c] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId)));
        return { settings, call: c ?? null };
      });
      const call = ctx.call;
      if (!call) return { status: 'gone' };
      if (call.aiSummaryStatus === 'done') return { status: 'already-done' };
      const transcript = call.transcript;
      if (!transcript) return { status: 'no-transcript' };
      // Off by default: the transcript only goes to Claude when the
      // workspace turned AI call summaries on.
      if (!ctx.settings.aiCallSummary) {
        await tenantTransaction((tx) => tx.update(calls).set({ aiSummaryStatus: 'transcript_only' }).where(eq(calls.id, callId)));
        return { status: 'disabled' };
      }
      if ((call.talkTimeSec ?? 0) < MIN_TALK_SEC) {
        await tenantTransaction((tx) => tx.update(calls).set({ aiSummaryStatus: 'skipped' }).where(eq(calls.id, callId)));
        return { status: 'too-short' };
      }
      if (!args.summarize && !claudeConfigured()) {
        await tenantTransaction((tx) => tx.update(calls).set({ aiSummaryStatus: 'transcript_only' }).where(eq(calls.id, callId)));
        return { status: 'transcript-only (no ANTHROPIC_API_KEY)' };
      }
      await tenantTransaction((tx) => tx.update(calls).set({ aiSummaryStatus: 'pending' }).where(eq(calls.id, callId)));
      const out = await summarize({ transcript, callDate: call.startedAt ?? call.createdAt, direction: call.direction });
      await recordAiInvocation({
        tenantId,
        actorUserId: null,
        kind: 'call_summary',
        model: out.usage.model,
        promptTokens: out.usage.inputTokens,
        completionTokens: out.usage.outputTokens,
        totalTokens: out.usage.inputTokens + out.usage.outputTokens,
        latencyMs: out.usage.latencyMs,
        status: out.ok ? 'success' : 'error',
        error: out.ok ? null : out.error.slice(0, 300),
        metadata: { callId, attempts: out.attempts },
      }).catch((err) => captureError(err, { category: 'telephony.summary.audit', retryable: false }));
      await tenantTransaction((tx) =>
        tx
          .update(calls)
          .set(out.ok ? { aiSummary: out.summary, aiSummaryStatus: 'done' } : { aiSummaryStatus: 'transcript_only' })
          .where(eq(calls.id, callId)),
      );
      if (out.ok) {
        // The summary's follow-up becomes a review-queue suggestion (one
        // mechanism for "Accept follow-up task"); then field suggestions may run.
        await tenantTransaction(async (tx) => {
          const [fresh] = await tx.select().from(calls).where(eq(calls.id, callId));
          if (fresh) await recordFollowUpSuggestion(tx, fresh);
        });
        await sendWorkflowEvent('crm/call.summarized', { tenantId, callId });
      }
      return out.ok ? { status: 'done', attempts: out.attempts } : { status: 'transcript-only', error: out.error };
    }),
  );
}

export const callAiSummarize = inngest.createFunction(
  {
    id: 'call-ai-summarize',
    name: 'Telephony — AI call summary',
    retries: 3,
    triggers: [callTranscribedEvent],
  },
  async ({ event, step }) => callAiSummarizeHandler({ event, step: step as unknown as LocalStepAPI }),
);

export const campaignDialerTick = inngest.createFunction(
  {
    id: 'campaign-dialer-tick',
    name: 'Telephony — dialer tick',
    retries: 1,
    concurrency: { limit: 1 },
    // Housekeeping only (agents claim calls themselves): releases claims past
    // their LOCK_MINUTES expiry and closes finished campaigns. Every 15 min, in
    // one step: the old every-minute, step-per-tenant tick used most of the
    // Inngest plan on its own. Worst case an abandoned claim now waits
    // LOCK_MINUTES + 15 before going back to the queue.
    triggers: [cron('*/15 * * * *')],
  },
  async ({ step }) =>
    step.run('tick-all', async () => {
      const all = await db.select({ id: tenants.id }).from(tenants);
      const r = await eachTenant(
        all.map((t) => t.id),
        'campaign-dialer-tick',
        (tenantId) =>
          runWithSystemContext(tenantId, async () => {
            const running = await tenantTransaction(async (tx) => {
              const rows = await tx.execute<{ n: number }>(
                sql`select count(*)::int as n from call_campaigns where tenant_id = ${tenantId} and status = 'running'`,
              );
              return Number(rows[0]?.n ?? 0);
            });
            return running ? await runDialerTick(tenantId) : null;
          }),
      );
      return { ticked: Object.fromEntries(Object.entries(r.ok).filter(([, v]) => v !== null)), failed: r.failed };
    }),
);
