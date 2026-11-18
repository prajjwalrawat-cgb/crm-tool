/**
 * Speech-to-text, pluggable. Picked by env `TELEPHONY_STT_PROVIDER`.
 *
 * Only 'none' ships today: it returns no transcript, so the AI summary step
 * records `transcript_only`/`skipped` and nothing leaves the server. A real
 * engine (one that handles Indian English and Hinglish) is a deliberate,
 * separate choice: it sends call audio to a third party. Implement this
 * interface, register it below, and record the choice in docs/BUILD_NOTES.md
 * after checking that provider's current docs.
 */
export interface Transcriber {
  readonly name: string;
  /** Returns plain text, or null when the engine produced nothing. */
  transcribe(audio: Uint8Array, opts: { contentType: string; languageHints: string[] }): Promise<string | null>;
}

export const noneTranscriber: Transcriber = {
  name: 'none',
  async transcribe() {
    return null;
  },
};

const registry: Record<string, Transcriber> = { none: noneTranscriber };

export function registerTranscriber(t: Transcriber): void {
  registry[t.name] = t;
}

export function getTranscriber(): Transcriber {
  const name = (process.env.TELEPHONY_STT_PROVIDER ?? 'none').trim().toLowerCase();
  return registry[name] ?? noneTranscriber;
}

export const LANGUAGE_HINTS = ['en-IN', 'hi-IN'];
