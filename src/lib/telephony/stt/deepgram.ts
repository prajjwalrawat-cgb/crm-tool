import type { TranscriptSegment } from '@/db/schema/telephony';

import {
  httpError,
  mergeSegments,
  networkError,
  SttError,
  type Transcriber,
  transcriptText,
} from './core';

/**
 * Deepgram pre-recorded STT (docs checked 2026-11-18:
 * developers.deepgram.com/reference/speech-to-text/listen-pre-recorded).
 *
 *   POST https://api.deepgram.com/v1/listen?<params>
 *   Authorization: Token <DEEPGRAM_API_KEY>, body = raw audio bytes
 *
 * - model `nova-3` (env DEEPGRAM_MODEL), language `multi` (env
 *   DEEPGRAM_LANGUAGE; Nova-3 multilingual covers English + Hindi
 *   code-switching; `hi` or `en-IN` are alternatives).
 * - Dual-channel audio: `multichannel=true`; each utterance carries its
 *   channel, mapped to agent/customer by `channelRoles`.
 * - Mono audio: `diarize_model=latest` (the docs mark `diarize` as
 *   deprecated). Diarised speakers can't be told apart as agent vs customer,
 *   so they are 'unknown' with a "Speaker N" label.
 * - `utterances=true` gives timed turns; smart_format + punctuate for text.
 * Limits from the docs: 2 GB per file, 504 after 10 minutes of processing.
 */

const ENDPOINT = 'https://api.deepgram.com/v1/listen';

type DgUtterance = { start: number; end: number; channel?: number; speaker?: number; transcript: string; confidence?: number };
type DgResponse = {
  metadata?: { duration?: number; channels?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      languages?: string[];
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
    }>;
    utterances?: DgUtterance[];
  };
};

export function deepgramModel(): string {
  return (process.env.DEEPGRAM_MODEL ?? 'nova-3').trim() || 'nova-3';
}

export function buildDeepgramUrl(opts: { dual: boolean; model: string; language: string }): string {
  const p = new URLSearchParams({
    model: opts.model,
    language: opts.language,
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
  });
  if (opts.dual) p.set('multichannel', 'true');
  else p.set('diarize_model', 'latest');
  return `${ENDPOINT}?${p.toString()}`;
}

/** Map a Deepgram response to our segments. Exported for selftests. */
export function parseDeepgram(
  body: DgResponse,
  opts: { dual: boolean; channelRoles: [TranscriptSegment['speaker'], TranscriptSegment['speaker']] },
): { segments: TranscriptSegment[]; language: string | null; durationMs: number | null } {
  const utts = body.results?.utterances ?? [];
  let segments: TranscriptSegment[];
  if (utts.length) {
    segments = mergeSegments([
      utts.map((u) => {
        const base = {
          startMs: Math.round(u.start * 1000),
          endMs: Math.round(u.end * 1000),
          text: u.transcript ?? '',
          confidence: typeof u.confidence === 'number' ? u.confidence : null,
        };
        if (opts.dual) return { ...base, speaker: opts.channelRoles[u.channel === 1 ? 1 : 0] };
        return { ...base, speaker: 'unknown' as const, label: `Speaker ${(u.speaker ?? 0) + 1}` };
      }),
    ]);
  } else {
    // No utterances: one segment per channel from the top alternative.
    segments = mergeSegments(
      (body.results?.channels ?? []).map((ch, i) => {
        const alt = ch.alternatives?.[0];
        const speaker = opts.dual ? opts.channelRoles[i === 1 ? 1 : 0] : ('unknown' as const);
        return [{ speaker, startMs: 0, endMs: Math.round((body.metadata?.duration ?? 0) * 1000), text: alt?.transcript ?? '', confidence: alt?.confidence ?? null }];
      }),
    );
  }
  const ch0 = body.results?.channels?.[0];
  const language = ch0?.detected_language ?? ch0?.languages?.[0] ?? null;
  const durationMs = typeof body.metadata?.duration === 'number' ? Math.round(body.metadata.duration * 1000) : null;
  return { segments, language, durationMs };
}

export const deepgramTranscriber: Transcriber = {
  name: 'deepgram',
  get model() {
    return deepgramModel();
  },
  configured: () => (process.env.DEEPGRAM_API_KEY ?? '').trim().length > 0,
  async transcribe(audio, opts) {
    const key = (process.env.DEEPGRAM_API_KEY ?? '').trim();
    if (!key) throw new SttError('deepgram: DEEPGRAM_API_KEY is not set', false);
    const doFetch = opts.fetch ?? fetch;
    const dual = (audio.channels ?? 1) >= 2;
    const model = deepgramModel();
    const language = (process.env.DEEPGRAM_LANGUAGE ?? 'multi').trim() || 'multi';
    let res: Response;
    try {
      res = await doFetch(buildDeepgramUrl({ dual, model, language }), {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': audio.contentType || 'audio/mpeg' },
        body: audio.bytes as BodyInit,
        signal: opts.signal,
      });
    } catch (err) {
      throw networkError('deepgram', 'listen', err);
    }
    if (!res.ok) throw await httpError('deepgram', 'listen', res);
    let body: DgResponse;
    try {
      body = (await res.json()) as DgResponse;
    } catch (err) {
      throw new SttError(`deepgram listen returned invalid JSON: ${(err as Error).message.slice(0, 80)}`, true);
    }
    const parsed = parseDeepgram(body, { dual, channelRoles: opts.channelRoles });
    return {
      text: transcriptText(parsed.segments),
      segments: parsed.segments,
      language: parsed.language ?? (language === 'multi' ? null : language),
      durationMs: parsed.durationMs,
      provider: 'deepgram',
      model,
      channelSeparated: dual,
    };
  },
};
