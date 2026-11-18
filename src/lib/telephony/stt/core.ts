import type { TranscriptSegment, TranscriptSpeaker } from '@/db/schema/telephony';

/**
 * Shared speech-to-text types, errors and helpers. Pure (no server-only, no
 * SDK) so adapters, the workflow, selftests and scripts/stt-eval.ts can all
 * import it.
 */

export type { TranscriptSegment, TranscriptSpeaker };

export type AudioInput = {
  bytes: Uint8Array;
  contentType: string;
  /** Channel count from the file header (audio-probe), or null if unknown. */
  channels: number | null;
};

export type TranscribeOptions = {
  languageHints: string[];
  /** Speaker for channel 0 and channel 1 of a dual-channel recording. */
  channelRoles: [TranscriptSpeaker, TranscriptSpeaker];
  signal?: AbortSignal;
  /** Injected in tests. */
  fetch?: typeof fetch;
};

export type TranscriptResult = {
  /** Plain text, one "Speaker: text" line per turn. */
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  durationMs: number | null;
  provider: string;
  model: string;
  /** True when speakers came from separate channels (reliable agent/customer labels). */
  channelSeparated: boolean;
};

export interface Transcriber {
  readonly name: string;
  readonly model: string;
  /** Has its API key. */
  configured(): boolean;
  /** Returns null only for `none`. Throws SttError on failure. */
  transcribe(audio: AudioInput, opts: TranscribeOptions): Promise<TranscriptResult | null>;
}

/** A provider failure. `retryable` drives the workflow's backoff. */
export class SttError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

/** 408, 425, 429 and 5xx are worth retrying; other 4xx are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Build an SttError from a failed HTTP response without echoing request data. */
export async function httpError(provider: string, step: string, res: Response): Promise<SttError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } | string; err_msg?: string; message?: string };
    const e = body?.error;
    detail = typeof e === 'string' ? e : (e?.code ?? e?.message ?? body?.err_msg ?? body?.message ?? '');
  } catch {
    /* non-JSON body: status only */
  }
  const msg = `${provider} ${step} failed: HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`;
  return new SttError(msg, isRetryableStatus(res.status), res.status);
}

/** Wrap network / abort errors. Aborts (our timeout) are retryable. */
export function networkError(provider: string, step: string, err: unknown): SttError {
  if (err instanceof SttError) return err;
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return new SttError(`${provider} ${step} timed out`, true);
  return new SttError(`${provider} ${step} network error: ${(err as Error)?.message?.slice(0, 120) ?? 'unknown'}`, true);
}

export function speakerLabel(s: TranscriptSegment): string {
  if (s.speaker === 'agent') return 'Agent';
  if (s.speaker === 'customer') return 'Customer';
  return s.label ?? 'Speaker';
}

/**
 * Merge per-channel (or per-speaker) segments into one timeline: sort by
 * start time, then join consecutive turns by the same speaker when the gap is
 * under `joinGapMs`. Empty text is dropped.
 */
export function mergeSegments(lists: TranscriptSegment[][], joinGapMs = 1500): TranscriptSegment[] {
  const all = lists
    .flat()
    .filter((s) => s.text.trim().length > 0)
    .map((s) => ({ ...s, text: s.text.trim() }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: TranscriptSegment[] = [];
  for (const s of all) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === s.speaker && prev.label === s.label && s.startMs - prev.endMs <= joinGapMs) {
      const conf =
        prev.confidence != null && s.confidence != null ? Math.min(prev.confidence, s.confidence) : (prev.confidence ?? s.confidence);
      out[out.length - 1] = { ...prev, endMs: Math.max(prev.endMs, s.endMs), text: `${prev.text} ${s.text}`, confidence: conf };
    } else out.push(s);
  }
  return out;
}

export function transcriptText(segments: TranscriptSegment[]): string {
  return segments.map((s) => `${speakerLabel(s)}: ${s.text}`).join('\n');
}

/** Default channel order. Exotel documents left = agent / first party. */
export function channelRolesFromEnv(): [TranscriptSpeaker, TranscriptSpeaker] {
  const v = (process.env.TELEPHONY_DUAL_CHANNEL_ORDER ?? 'agent,customer').trim().toLowerCase();
  return v === 'customer,agent' ? ['customer', 'agent'] : ['agent', 'customer'];
}

