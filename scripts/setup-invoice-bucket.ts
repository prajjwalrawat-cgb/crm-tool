import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });
config();

/**
 * Ensure the Supabase Storage bucket for invoice line-item images exists
 * and is public. Idempotent. Run: pnpm setup:invoice-bucket
 */
async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_INVOICE_BUCKET ?? 'invoice-items';
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: existing, error: listErr } = await supabase.storage.getBucket(bucket);
  if (existing) {
    if (!existing.public) {
      const { error } = await supabase.storage.updateBucket(bucket, { public: true });
      if (error) throw error;
      console.log(`Bucket "${bucket}" existed; made it public.`);
    } else {
      console.log(`Bucket "${bucket}" already exists and is public. Nothing to do.`);
    }
    return;
  }
  // getBucket returns an error when the bucket is missing — create it.
  if (listErr) console.log(`Bucket "${bucket}" not found, creating…`);

  const { error } = await supabase.storage.createBucket(bucket, {
    public: true,
    fileSizeLimit: '6MB',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  if (error) throw error;
  console.log(`Created public bucket "${bucket}".`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('setup-invoice-bucket failed:', err.message ?? err);
    process.exit(1);
  });
