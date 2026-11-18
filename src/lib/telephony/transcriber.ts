import type { Transcriber } from './stt/core';
import { deepgramTranscriber } from './stt/deepgram';
import { sarvamTranscriber } from './stt/sarvam';

export * from './stt/core';

/**
 * Speech-to-text, pluggable. Each workspace picks its provider in Settings >
 * Telephony (telephony_settings.transcription_provider: `deepgram` | `sarvam`;
 * unset = no transcription). API keys are server env: DEEPGRAM_API_KEY,
 * SARVAM_API_KEY.
 *
 * Sending call audio to a provider is a deliberate choice: it only happens
 * when the server has a provider + key AND the workspace turned transcription
 * on and confirmed recording consent (telephony_settings, 0076). The workflow
 * (`callTranscribe` in inngest/workflows/telephony.ts) enforces the workspace
 * switch; this module only knows about providers.
 *
 * Adapters never log audio or transcript text, and their error messages carry
 * only the HTTP status and the provider's error code/message.
 */

export const noneTranscriber: Transcriber = {
  name: 'none',
  model: 'none',
  configured: () => true,
  async transcribe() {
    return null;
  },
};

const registry: Record<string, Transcriber> = { none: noneTranscriber };

export function registerTranscriber(t: Transcriber): void {
  registry[t.name] = t;
}

registerTranscriber(sarvamTranscriber);
registerTranscriber(deepgramTranscriber);

export function getTranscriberByName(name: string): Transcriber | null {
  return registry[name.trim().toLowerCase()] ?? null;
}

export function listTranscribers(): Transcriber[] {
  return Object.values(registry).filter((t) => t.name !== 'none');
}

/** The workspace's chosen provider (telephony_settings.transcription_provider); `none` when unset or unknown. */
export function getTranscriber(name: string | null | undefined): Transcriber {
  return (name && registry[name.trim().toLowerCase()]) || noneTranscriber;
}

export const STT_PROVIDER_LABELS: Record<string, string> = { deepgram: 'Deepgram', sarvam: 'Sarvam AI' };

/** For the settings page: every provider, and whether the server has its API key. */
export function sttProviderOptions(): Array<{ name: string; label: string; configured: boolean }> {
  return listTranscribers().map((t) => ({ name: t.name, label: STT_PROVIDER_LABELS[t.name] ?? t.name, configured: t.configured() }));
}

export const LANGUAGE_HINTS = ['en-IN', 'hi-IN'];
