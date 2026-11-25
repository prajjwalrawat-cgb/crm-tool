import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
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

/** Cached ok/failed verdict for an address, or null on a miss. */
export async function geocodeLookup(tx: DbExecutor, tenantId: string, address: string): Promise<GeocodeResult | null> {
  const normalized = normalizeAddress(address);
  if (!normalized) return { status: 'failed' };
  const [hit] = await tx
    .select()
    .from(geocodeCache)
    .where(and(eq(geocodeCache.tenantId, tenantId), eq(geocodeCache.normalizedAddress, normalized)))
    .limit(1);
  if (hit?.status === 'ok' && hit.lat !== null && hit.lng !== null) {
    return { status: 'ok', point: { lat: hit.lat, lng: hit.lng } };
  }
  if (hit?.status === 'failed') return { status: 'failed' };
  return null;
}

/** Store a provider verdict; `pending` is never stored. */
export async function geocodeStore(
  tx: DbExecutor,
  tenantId: string,
  address: string,
  res: GeocodeResult,
  providerName: string,
  opts: Opts = {},
): Promise<void> {
  const normalized = normalizeAddress(address);
  if (!normalized || res.status === 'pending') return;
  const row = {
    lat: res.point?.lat ?? null,
    lng: res.point?.lng ?? null,
    status: res.status,
    provider: providerName,
    fetchedAt: (opts.now ?? (() => new Date()))(),
  };
  await tx
    .insert(geocodeCache)
    .values({ tenantId, normalizedAddress: normalized, ...row })
    .onConflictDoUpdate({ target: [geocodeCache.tenantId, geocodeCache.normalizedAddress], set: row });
}

/** Caches ok/failed verdicts only; `pending` (no key / transient) is never stored. */
export async function geocodeCached(
  tx: DbExecutor,
  tenantId: string,
  address: string,
  maps: MapsProvider,
  opts: Opts = {},
): Promise<GeocodeResult> {
  const hit = await geocodeLookup(tx, tenantId, address);
  if (hit) return hit;
  const res = await maps.geocode(address);
  await geocodeStore(tx, tenantId, address, res, maps.name, opts);
  return res;
}

const bucketOf = (departAt: Date) => new Date(Math.floor(departAt.getTime() / TTL_MS) * TTL_MS);

/** Cache key of one drive lookup (4-decimal points, 30-minute departure bucket). */
export function driveKey(a: LatLng, b: LatLng, departAt: Date): string {
  return `${key(a)}|${key(b)}|${bucketOf(departAt).toISOString()}`;
}

export type DrivePair = { a: LatLng; b: LatLng; departAt: Date };

/**
 * Fresh (within the TTL) cached minutes for each pair, keyed by `driveKey`.
 * One query for the whole batch; misses are absent from the map.
 */
export async function driveLookupMany(
  tx: DbExecutor,
  tenantId: string,
  pairs: DrivePair[],
  opts: Opts = {},
): Promise<Map<string, DriveResult>> {
  const out = new Map<string, DriveResult>();
  if (pairs.length === 0) return out;
  const now = (opts.now ?? (() => new Date()))();
  const origins = [...new Set(pairs.map((p) => key(p.a)))];
  const dests = [...new Set(pairs.map((p) => key(p.b)))];
  const buckets = [...new Set(pairs.map((p) => bucketOf(p.departAt).getTime()))].map((t) => new Date(t));
  const rows = await tx
    .select()
    .from(driveTimeCache)
    .where(
      and(
        eq(driveTimeCache.tenantId, tenantId),
        inArray(driveTimeCache.originKey, origins),
        inArray(driveTimeCache.destKey, dests),
        inArray(driveTimeCache.departBucket, buckets),
      ),
    );
  const wanted = new Set(pairs.map((p) => driveKey(p.a, p.b, p.departAt)));
  for (const r of rows) {
    const k = `${r.originKey}|${r.destKey}|${r.departBucket.toISOString()}`;
    if (wanted.has(k) && now.getTime() - r.fetchedAt.getTime() <= TTL_MS) out.set(k, { minutes: r.minutes, estimate: false });
  }
  return out;
}

/** Store a provider answer. Estimates are never stored: they must not mask a later real key. */
export async function driveStore(
  tx: DbExecutor,
  tenantId: string,
  pair: DrivePair,
  res: DriveResult,
  providerName: string,
  opts: Opts = {},
): Promise<void> {
  if (res.estimate) return;
  const now = (opts.now ?? (() => new Date()))();
  const set = { minutes: res.minutes, provider: providerName, fetchedAt: now };
  await tx
    .insert(driveTimeCache)
    .values({ tenantId, originKey: key(pair.a), destKey: key(pair.b), departBucket: bucketOf(pair.departAt), ...set })
    .onConflictDoUpdate({
      target: [driveTimeCache.tenantId, driveTimeCache.originKey, driveTimeCache.destKey, driveTimeCache.departBucket],
      set,
    });
}

/**
 * Cache read, provider call and cache write on one executor. The provider call
 * runs while `tx` is open, so the caller's transaction must be short and hold no
 * locks (the risk scan opens one per lookup). getDay uses the batch helpers above
 * and calls the provider with no transaction open.
 */
export async function driveMinutesCached(
  tx: DbExecutor,
  tenantId: string,
  a: LatLng,
  b: LatLng,
  departAt: Date,
  maps: MapsProvider,
  opts: Opts = {},
): Promise<DriveResult> {
  const pair = { a, b, departAt };
  const hit = (await driveLookupMany(tx, tenantId, [pair], opts)).get(driveKey(a, b, departAt));
  if (hit) return hit;
  const res = await maps.driveMinutes(a, b, departAt);
  await driveStore(tx, tenantId, pair, res, maps.name, opts);
  return res;
}
