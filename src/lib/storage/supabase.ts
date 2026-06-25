import 'server-only';

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Thin wrapper over Supabase Storage for invoice line-item images. Uses
 * the service-role key (server-only — never exposed to the client) so it
 * can write regardless of bucket RLS. Configure via env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_INVOICE_BUCKET.
 */

let cached: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment.',
    );
  }
  if (!cached) {
    cached = createClient(url, key, { auth: { persistSession: false } });
  }
  return cached;
}

export function invoiceBucket(): string {
  return process.env.SUPABASE_INVOICE_BUCKET ?? 'invoice-items';
}

export function isStorageConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Upload image bytes and return the public URL. Path is tenant-scoped. */
export async function uploadInvoiceImage(input: {
  tenantId: string;
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}): Promise<string> {
  const client = getClient();
  const bucket = invoiceBucket();
  const path = `${input.tenantId}/${randomUUID()}.${input.ext}`;

  const { error } = await client.storage
    .from(bucket)
    .upload(path, input.bytes, { contentType: input.contentType, upsert: false });
  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
