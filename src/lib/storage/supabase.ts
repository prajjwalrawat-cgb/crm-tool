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

export function dealDocumentsBucket(): string {
  return process.env.SUPABASE_DEAL_DOCS_BUCKET ?? 'deal-documents';
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

/**
 * Upload an arbitrary deal document (proposal / contract / pricing sheet /
 * other). Stored under a tenant + deal scoped path so objects are easy to
 * find and clean up. Returns both the public URL (for preview/download) and
 * the object path (needed to delete the object when the row is removed).
 */
export async function uploadDealDocument(input: {
  tenantId: string;
  dealId: string;
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
}): Promise<{ url: string; path: string }> {
  const client = getClient();
  const bucket = dealDocumentsBucket();
  // Keep a readable, collision-proof key; sanitize the original name.
  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const path = `${input.tenantId}/${input.dealId}/${randomUUID()}-${safeName}`;

  const { error } = await client.storage
    .from(bucket)
    .upload(path, input.bytes, {
      contentType: input.contentType,
      upsert: false,
    });
  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return {
    url: client.storage.from(bucket).getPublicUrl(path).data.publicUrl,
    path,
  };
}

/** Best-effort removal of a stored object. Never throws — logs and moves on. */
export async function deleteDealDocument(path: string): Promise<void> {
  try {
    const client = getClient();
    await client.storage.from(dealDocumentsBucket()).remove([path]);
  } catch {
    // The DB row is the source of truth; a dangling object is tolerable.
  }
}
