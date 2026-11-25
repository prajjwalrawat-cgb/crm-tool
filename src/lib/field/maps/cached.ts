import 'server-only';

import { and, eq } from 'drizzle-orm';
import { driveTimeCache, geocodeCache } from '@/db/schema';
import type { DbExecutor } from '@/lib/db-context';
import type { LatLng } from '../types';
import type { DriveResult, GeocodeResult, MapsProvider } from './types';

const TTL_MS = 30 * 60 * 1000;
type Opts = { now?: () => Date };

export function normalizeAddress(a: string): string {
  return a
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const key = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

/** Caches ok/failed verdicts only; `pending` (no key / transient) is never stored. */
export async function geocodeCached(
  tx: DbExecutor,
  tenantId: string,
  address: string,
  maps: MapsProvider,
  opts: Opts = {},
): Promise<GeocodeResult> {
  const normalized = normalizeAddress(address);
  if (!normalized) return { status: 'failed' };
  const [hit] = await tx
    .select()
    .from(geocodeCache)
    .where(and(eq(geocodeCache.tenantId, tenantId), eq(geocodeCache.normalizedAddress, normalized)))
    .limit(1);
  if (hit) {
    if (hit.status === 'ok' && hit.lat !== null && hit.lng !== null) {
      return { status: 'ok', point: { lat: hit.lat, lng: hit.lng } };
    }
    if (hit.status === 'failed') return { status: 'failed' };
  }
  const res = await maps.geocode(address);
  if (res.status === 'pending') return res;
  const row = {
    lat: res.point?.lat ?? null,
    lng: res.point?.lng ?? null,
    status: res.status,
    provider: maps.name,
    fetchedAt: (opts.now ?? (() => new Date()))(),
  };
  await tx
    .insert(geocodeCache)
    .values({ tenantId, normalizedAddress: normalized, ...row })
    .onConflictDoUpdate({ target: [geocodeCache.tenantId, geocodeCache.normalizedAddress], set: row });
  return res;
}

export async function driveMinutesCached(
  tx: DbExecutor,
  tenantId: string,
  a: LatLng,
  b: LatLng,
  departAt: Date,
  maps: MapsProvider,
  opts: Opts = {},
): Promise<DriveResult> {
  const now = (opts.now ?? (() => new Date()))();
  const bucket = new Date(Math.floor(departAt.getTime() / TTL_MS) * TTL_MS);
  const originKey = key(a);
  const destKey = key(b);
  const [hit] = await tx
    .select()
    .from(driveTimeCache)
    .where(
      and(
        eq(driveTimeCache.tenantId, tenantId),
        eq(driveTimeCache.originKey, originKey),
        eq(driveTimeCache.destKey, destKey),
        eq(driveTimeCache.departBucket, bucket),
      ),
    )
    .limit(1);
  if (hit && now.getTime() - hit.fetchedAt.getTime() <= TTL_MS) {
    return { minutes: hit.minutes, estimate: false };
  }
  const res = await maps.driveMinutes(a, b, departAt);
  if (res.estimate) return res; // estimator is cheap and must not mask a later real key
  const set = { minutes: res.minutes, provider: maps.name, fetchedAt: now };
  await tx
    .insert(driveTimeCache)
    .values({ tenantId, originKey, destKey, departBucket: bucket, ...set })
    .onConflictDoUpdate({
      target: [driveTimeCache.tenantId, driveTimeCache.originKey, driveTimeCache.destKey, driveTimeCache.departBucket],
      set,
    });
  return res;
}
