import 'server-only';

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { captureError } from '@/lib/observability';

/**
 * Fixed-window rate limiting backed by Postgres (`rate_limit_hit`, 0072).
 * Serverless instances share no memory, so the counter lives in the DB: one
 * atomic upsert per check.
 *
 * Fails OPEN on a database error. These endpoints receive leads, and dropping
 * a real enquiry because the limiter hiccuped is worse than briefly letting
 * extra traffic through (which still has to authenticate).
 */
export async function rateLimitHit(bucket: string, limit: number, windowSeconds = 60): Promise<boolean> {
  try {
    const rows = await db.execute<{ ok: boolean }>(
      sql`select rate_limit_hit(${bucket}, ${windowSeconds}, ${limit}) as ok`,
    );
    return rows[0]?.ok !== false;
  } catch (err) {
    captureError(err, { category: 'lead-capture.rate-limit', retryable: true });
    return true;
  }
}

/** Client IP from proxy headers, hashed so raw IPs are never stored. */
export function clientIpBucket(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = fwd || headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(`ip:${ip}`).digest('hex').slice(0, 32);
}
