import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });
config();

/**
 * Ensure the Supabase Storage bucket for deal documents exists and is public.
 * Idempotent. Run: npm run setup:deal-docs
 *
 * Mime types + size limit mirror the server-side guard in
 * src/app/dashboard/deals/[id]/document-actions.ts.
 */
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_DEAL_DOCS_BUCKET ?? 'deal-documents';
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: existing } = await supabase.storage.getBucket(bucket);
  if (existing) {
    // Keep the bucket public and refresh its limits/types in case they drifted.
    const { error } = await supabase.storage.updateBucket(bucket, {
      public: true,
      fileSizeLimit: '15MB',
      allowedMimeTypes: ALLOWED_MIME_TYPES,
    });
    if (error) throw error;
    console.log(`Bucket "${bucket}" already existed; ensured public + limits.`);
    return;
  }

  console.log(`Bucket "${bucket}" not found, creating…`);
  const { error } = await supabase.storage.createBucket(bucket, {
    public: true,
    fileSizeLimit: '15MB',
    allowedMimeTypes: ALLOWED_MIME_TYPES,
  });
  if (error) throw error;
  console.log(`Created public bucket "${bucket}".`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('setup-deal-documents-bucket failed:', err.message ?? err);
    process.exit(1);
  });
