import 'server-only';

import { and, eq, isNull, lt, or, inArray, sql } from 'drizzle-orm';

import { callRecordingAccess, calls, type MembershipRole } from '@/db/schema';
import { recordAiInvocation } from '@/lib/ai/audit';
import { tenantTransaction } from '@/lib/db-context';
import { captureError, incr } from '@/lib/observability';

import { getTelephonySettings } from './accounts';
import { getCallScoped } from './service';
import { downloadRecordingCapped, RecordingTooLargeError } from './storage';
import { probeAudio } from './stt/audio-probe';
import {
  channelRolesFromEnv,
  getTranscriber,
  LANGUAGE_HINTS,
  SttError,
  type Transcriber,
} from './transcriber';

/**
 * Call transcription (build prompt "Call transcription").
 *
 * Flow, driven by `callTranscribe` (inngest/workflows/telephony.ts):
 *   prepareTranscription  gate (workspace switch + consent, provider, caps) and
 *                         CLAIM the call (transcript_status -> pending)
 *   attemptTranscription  download (capped) -> probe channels -> provider ->
 *                         persist; returns done | retry | fail
 *   markTranscriptionFailed after the last attempt
 *
 * Idempotent: the claim is a conditional UPDATE, so a call that is `done`, or
 * `pending` and fresh, is never transcribed twice (duplicate events, retries,
 * a double-clicked Retry). A `pending` claim older than STALE_PENDING_MS (a
 * crashed run) can be taken over.
 *
 * Fails soft: nothing here touches call status, disposition or timeline rows,
 * and every error ends as transcript_status = failed with a short reason.
 * Audio and transcript text are never logged.
 */

export const STALE_PENDING_MS = 15 * 60_000;

export function sttLimits() {
  const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxBytes: num(process.env.TELEPHONY_STT_MAX_BYTES, 50 * 1024 * 1024),
    maxSeconds: num(process.env.TELEPHONY_STT_MAX_SECONDS, 60 * 60),
    minTalkSec: num(process.env.TELEPHONY_STT_MIN_TALK_SEC, 10),
    timeoutMs: num(process.env.TELEPHONY_STT_TIMEOUT_MS, 240_000),
  };
}

export type TranscribeDeps = {
  transcriber?: Transcriber;
  loadAudio?: (key: string, maxBytes: number, signal: AbortSignal) => Promise<{ bytes: Uint8Array; contentType: string }>;
};

type PrepareResult =
  | { status: 'claimed'; provider: string }
  | { status: 'skipped'; reason: string }
  | { status: 'noop'; reason: string };

/** Rows the claim may take: never attempted, failed, skipped, or a stale pending claim. */
function claimable(staleBefore: Date) {
  return or(
    isNull(calls.transcriptStatus),
    inArray(calls.transcriptStatus, ['failed', 'skipped']),
    and(eq(calls.transcriptStatus, 'pending'), lt(calls.transcriptStartedAt, staleBefore)),
  );
}

export async function prepareTranscription(tenantId: string, callId: string, deps: TranscribeDeps = {}): Promise<PrepareResult> {
  const limits = sttLimits();
  const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
  return await tenantTransaction(async (tx) => {
    const settings = await getTelephonySettings(tx, tenantId);
    const transcriber = deps.transcriber ?? getTranscriber(settings.transcriptionProvider);
    const [call] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId)));
    if (!call) return { status: 'noop', reason: 'call not found' } as const;
    if (call.transcriptStatus === 'done') return { status: 'noop', reason: 'already transcribed' } as const;
    if (call.transcriptStatus === 'pending' && call.transcriptStartedAt && call.transcriptStartedAt > staleBefore) {
      return { status: 'noop', reason: 'already in progress' } as const;
    }
    if (!call.recordingStorageKey) return { status: 'noop', reason: 'no archived recording' } as const;

    let skip: string | null = null;
    if (!settings.transcriptionEnabled) skip = 'Transcription is turned off for this workspace.';
    else if (!settings.transcriptionConsentAt) skip = 'Recording consent has not been confirmed in telephony settings.';
    else if (transcriber.name === 'none') skip = 'No speech-to-text provider is selected in Settings > Telephony.';
    else if (!transcriber.configured()) skip = `The ${transcriber.name} API key is not set.`;
    else if ((call.talkTimeSec ?? call.durationSec ?? 0) < limits.minTalkSec) skip = `Call is shorter than ${limits.minTalkSec} seconds.`;
    else if ((call.durationSec ?? call.talkTimeSec ?? 0) > limits.maxSeconds) skip = `Call is longer than the ${Math.round(limits.maxSeconds / 60)}-minute limit.`;

    if (skip) {
      await tx
        .update(calls)
        .set({ transcriptStatus: 'skipped', transcriptError: skip })
        .where(and(eq(calls.id, callId), claimable(staleBefore)));
      return { status: 'skipped', reason: skip } as const;
    }

    const claimed = await tx
      .update(calls)
      .set({ transcriptStatus: 'pending', transcriptError: null, transcriptStartedAt: new Date(), transcriptProvider: transcriber.name })
      .where(and(eq(calls.id, callId), claimable(staleBefore)))
      .returning({ id: calls.id });
    if (claimed.length === 0) return { status: 'noop', reason: 'claimed elsewhere' } as const;
    return { status: 'claimed', provider: transcriber.name } as const;
  });
}

export type AttemptResult = { kind: 'done'; segments: number } | { kind: 'retry'; error: string } | { kind: 'fail'; error: string };

export async function attemptTranscription(
  tenantId: string,
  callId: string,
  opts: { requestedBy?: string | null; provider?: string | null } & TranscribeDeps = {},
): Promise<AttemptResult> {
  // The provider claimed in prepareTranscription, so a settings change mid-run can't switch it.
  const transcriber = opts.transcriber ?? getTranscriber(opts.provider);
  const loadAudio = opts.loadAudio ?? downloadRecordingCapped;
  const limits = sttLimits();
  const actor = opts.requestedBy ?? 'system';

  const call = await tenantTransaction(async (tx) => {
    const [c] = await tx
      .update(calls)
      .set({ transcriptAttempts: sql`${calls.transcriptAttempts} + 1` })
      .where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId), eq(calls.transcriptStatus, 'pending')))
      .returning();
    if (c?.recordingStorageKey) {
      // Same access log as playback: the recording left storage for STT.
      await tx.insert(callRecordingAccess).values({ tenantId, callId, userId: actor, rangeHeader: `stt:${transcriber.name}` });
    }
    return c ?? null;
  });
  if (!call) return { kind: 'fail', error: 'Transcription was cancelled (the call is no longer pending).' };
  if (!call.recordingStorageKey) return { kind: 'fail', error: 'No archived recording.' };

  const t0 = Date.now();
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let audioSeconds: number | null = null;
  let channels: number | null = null;
  try {
    const audio = await loadAudio(call.recordingStorageKey, limits.maxBytes, signal);
    const probe = probeAudio(audio.bytes.subarray(0, 128 * 1024));
    channels = probe.channels;
    const result = await transcriber.transcribe(
      { bytes: audio.bytes, contentType: audio.contentType, channels: probe.channels },
      { languageHints: LANGUAGE_HINTS, channelRoles: channelRolesFromEnv(), signal },
    );
    if (!result || result.segments.length === 0 || !result.text.trim()) {
      await audit({ tenantId, actor: opts.requestedBy, transcriber, t0, status: 'error', error: 'empty transcript', meta: { channels } });
      return { kind: 'fail', error: 'The provider returned no speech.' };
    }
    audioSeconds = result.durationMs != null ? Math.round(result.durationMs / 1000) : (call.durationSec ?? null);
    const saved = await tenantTransaction((tx) =>
      tx
        .update(calls)
        .set({
          transcript: result.text,
          transcriptSegments: result.segments,
          transcriptLanguage: result.language,
          transcriptProvider: result.provider,
          transcriptModel: result.model,
          transcriptStatus: 'done',
          transcriptError: null,
          transcriptCompletedAt: new Date(),
        })
        .where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId), eq(calls.transcriptStatus, 'pending')))
        .returning({ id: calls.id }),
    );
    await audit({
      tenantId,
      actor: opts.requestedBy,
      transcriber,
      t0,
      status: 'success',
      meta: { audioSeconds, channels, sampleRate: probe.sampleRate, format: probe.format, segments: result.segments.length, channelSeparated: result.channelSeparated, language: result.language },
    });
    incr('telephony.stt.done', 1, { provider: transcriber.name });
    if (saved.length === 0) return { kind: 'fail', error: 'Transcription was cancelled while running.' };
    return { kind: 'done', segments: result.segments.length };
  } catch (err) {
    const tooLarge = err instanceof RecordingTooLargeError;
    const retryable = tooLarge ? false : err instanceof SttError ? err.retryable : true;
    const message = tooLarge
      ? `Recording is larger than the ${Math.round(limits.maxBytes / 1024 / 1024)} MB limit.`
      : (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await audit({ tenantId, actor: opts.requestedBy, transcriber, t0, status: 'error', error: message, meta: { channels, audioSeconds } });
    captureError(err, { category: 'telephony.stt', retryable, fields: { callId, provider: transcriber.name } });
    return retryable ? { kind: 'retry', error: message } : { kind: 'fail', error: message };
  }
}

async function audit(a: {
  tenantId: string;
  actor: string | null | undefined;
  transcriber: Transcriber;
  t0: number;
  status: 'success' | 'error';
  error?: string;
  meta: Record<string, unknown>;
}) {
  await recordAiInvocation({
    tenantId: a.tenantId,
    actorUserId: a.actor ?? null,
    kind: 'stt',
    model: a.transcriber.model,
    latencyMs: Date.now() - a.t0,
    status: a.status,
    error: a.error ?? null,
    metadata: { provider: a.transcriber.name, ...a.meta },
  }).catch((err) => captureError(err, { category: 'telephony.stt.audit', retryable: false }));
}

export async function markTranscriptionFailed(tenantId: string, callId: string, error: string): Promise<void> {
  await tenantTransaction((tx) =>
    tx
      .update(calls)
      .set({ transcriptStatus: 'failed', transcriptError: error.slice(0, 300) })
      .where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId), eq(calls.transcriptStatus, 'pending'))),
  );
  incr('telephony.stt.failed', 1);
}

/**
 * Retry from the UI. Runs as the acting user: the call must be one they may
 * see (same scope as playback), and only failed / skipped / never-attempted
 * transcripts can be retried. The caller then emits
 * `crm/call.transcribe_requested`; the workflow re-checks the workspace
 * switch, consent and caps.
 */
export async function canRetryTranscription(args: {
  tenantId: string;
  viewer: { userId: string; role: MembershipRole };
  callId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (args.viewer.role === 'viewer') return { ok: false, error: 'Viewers cannot retry transcription.' };
  const call = await getCallScoped(args.tenantId, args.viewer, args.callId);
  if (!call) return { ok: false, error: 'Call not found.' };
  if (!call.recordingStorageKey) return { ok: false, error: 'This call has no archived recording.' };
  if (call.transcriptStatus === 'done') return { ok: false, error: 'This call is already transcribed.' };
  const fresh = call.transcriptStartedAt && call.transcriptStartedAt.getTime() > Date.now() - STALE_PENDING_MS;
  if (call.transcriptStatus === 'pending' && fresh) return { ok: false, error: 'Transcription is already running.' };
  return { ok: true };
}
