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
import { downloadRecordingBytes, uploadRecording } from '@/lib/telephony/storage';
import { getTranscriber, LANGUAGE_HINTS } from '@/lib/telephony/transcriber';

import { callCompletedEvent, callEventReceivedEvent, callRecordingArchivedEvent, inngest } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI } from '../local-step';
import { sendWorkflowEvent } from '../send';

/**
 * Telephony workflows (build prompt 2):
 *   call-event-process     crm/call.event_received → upsert call, side effects
 *   call-recording-archive crm/call.completed → copy recording to our storage
 *   call-ai-summarize      crm/call.recording_archived → transcript + Claude summary
 *   campaign-dialer-tick   every minute → stale claims, completed campaigns
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

/** AI summary needs this much talk time to be worth a transcript. */
const MIN_TALK_SEC = 45;

export async function callAiSummarizeHandler(args: { event: { data: WorkflowEvents['crm/call.recording_archived'] }; step: LocalStepAPI }) {
  const { tenantId, callId } = args.event.data;
  return await args.step.run('summarize', () =>
    runWithSystemContext(tenantId, async () => {
      const ctx = await tenantTransaction(async (tx) => {
        const settings = await getTelephonySettings(tx, tenantId);
        const [c] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId)));
        return { settings, call: c ?? null };
      });
      const call = ctx.call;
      if (!call || !call.recordingStorageKey) return { status: 'no-recording' };
      // Off by default: no audio or transcript leaves the server unless the
      // workspace turned AI call summaries on.
      if (!ctx.settings.aiCallSummary) return { status: 'disabled' };
      if ((call.talkTimeSec ?? 0) < MIN_TALK_SEC) {
        await tenantTransaction((tx) => tx.update(calls).set({ aiSummaryStatus: 'skipped' }).where(eq(calls.id, callId)));
        return { status: 'too-short' };
      }
      const transcriber = getTranscriber();
      let transcript = call.transcript;
      if (!transcript) {
        const audio = await downloadRecordingBytes(call.recordingStorageKey);
        transcript = await transcriber.transcribe(audio.bytes, { contentType: audio.contentType, languageHints: LANGUAGE_HINTS });
      }
      if (!transcript) {
        await tenantTransaction((tx) => tx.update(calls).set({ aiSummaryStatus: 'skipped' }).where(eq(calls.id, callId)));
        return { status: `no-transcript (${transcriber.name})` };
      }
      await tenantTransaction((tx) => tx.update(calls).set({ transcript, aiSummaryStatus: 'pending' }).where(eq(calls.id, callId)));
      if (!claudeConfigured()) {
        await tenantTransaction((tx) => tx.update(calls).set({ aiSummaryStatus: 'transcript_only' }).where(eq(calls.id, callId)));
        return { status: 'transcript-only (no ANTHROPIC_API_KEY)' };
      }
      const out = await summarizeCallTranscript({ transcript, callDate: call.startedAt ?? call.createdAt, direction: call.direction });
      await tenantTransaction((tx) =>
        tx
          .update(calls)
          .set(out.ok ? { aiSummary: out.summary, aiSummaryStatus: 'done' } : { aiSummaryStatus: 'transcript_only' })
          .where(eq(calls.id, callId)),
      );
      return out.ok ? { status: 'done', attempts: out.attempts } : { status: 'transcript-only', error: out.error };
    }),
  );
}

export const callAiSummarize = inngest.createFunction(
  {
    id: 'call-ai-summarize',
    name: 'Telephony — AI call summary',
    retries: 3,
    idempotency: 'event.data.callId',
    triggers: [callRecordingArchivedEvent],
  },
  async ({ event, step }) => callAiSummarizeHandler({ event, step: step as unknown as LocalStepAPI }),
);

export const campaignDialerTick = inngest.createFunction(
  {
    id: 'campaign-dialer-tick',
    name: 'Telephony — dialer tick',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [cron('* * * * *')],
  },
  async ({ step }) => {
    const all = await step.run('list-tenants', () => db.select({ id: tenants.id }).from(tenants));
    const results: Record<string, unknown> = {};
    for (const t of all) {
      const running = await step.run(`running-${t.id}`, () =>
        runWithSystemContext(t.id, () =>
          tenantTransaction(async (tx) => {
            const rows = await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from call_campaigns where tenant_id = ${t.id} and status = 'running'`,
            );
            return Number(rows[0]?.n ?? 0);
          }),
        ),
      );
      if (!running) continue;
      results[t.id] = await step.run(`tick-${t.id}`, () => runWithSystemContext(t.id, () => runDialerTick(t.id)));
    }
    return results;
  },
);
