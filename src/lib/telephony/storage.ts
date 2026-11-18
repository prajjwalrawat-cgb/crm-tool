import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Call recordings in Supabase Storage (S3-compatible), bucket env
 * `SUPABASE_CALL_RECORDINGS_BUCKET` (default 'call-recordings', PRIVATE).
 * Objects live at tenant/{tenantId}/calls/{callId}.mp3.
 *
 * The bucket must be private: playback goes through /api/calls/:id/recording,
 * which checks access, logs the play, and proxies a short-lived signed URL
 * server-side (Range passed through). Neither the signed URL nor the object
 * key is ever sent to the browser.
 */

let cached: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  cached ??= createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

export function recordingsBucket(): string {
  return process.env.SUPABASE_CALL_RECORDINGS_BUCKET ?? 'call-recordings';
}

export function recordingKey(tenantId: string, callId: string): string {
  return `tenant/${tenantId}/calls/${callId}.mp3`;
}

export async function uploadRecording(args: { tenantId: string; callId: string; bytes: Uint8Array; contentType: string }): Promise<string> {
  const key = recordingKey(args.tenantId, args.callId);
  const { error } = await getClient()
    .storage.from(recordingsBucket())
    .upload(key, args.bytes, { contentType: args.contentType || 'audio/mpeg', upsert: true });
  if (error) throw new Error(`Recording upload failed: ${error.message}`);
  return key;
}

/** Fetch (a range of) the stored recording. Returns the upstream Response. */
export async function fetchStoredRecording(key: string, range: string | null): Promise<Response> {
  const { data, error } = await getClient().storage.from(recordingsBucket()).createSignedUrl(key, 60);
  if (error || !data?.signedUrl) throw new Error(`Recording not available: ${error?.message ?? 'no url'}`);
  return await fetch(data.signedUrl, { headers: range ? { Range: range } : {} });
}

export async function downloadRecordingBytes(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { data, error } = await getClient().storage.from(recordingsBucket()).download(key);
  if (error || !data) throw new Error(`Recording download failed: ${error?.message ?? 'empty'}`);
  return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type || 'audio/mpeg' };
}
