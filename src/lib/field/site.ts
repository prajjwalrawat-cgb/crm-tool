import 'server-only';

import type { Company } from '@/db/schema';
import type { GeocodeStatus } from '@/db/schema/enums';

import { parseSiteInput } from './geo';
import { companyGeocodeLine, isCompanyAddress } from './site-line';
import type { Tx } from './internal';
import { geocodeLookup, geocodeStore } from './maps/cached';
import type { GeocodeResult, MapsProvider } from './maps';
import { FieldError, type LatLng } from './types';

/**
 * Meeting site resolution. Network calls (geocoding, short-link resolution)
 * happen BEFORE the write transaction; inside it we only read/write the cache.
 *
 *   plan (read tx: cache lookup) → fetch (no tx) → siteFor (write tx: store + apply)
 */

/**
 * Where a meeting's point comes from (meetings.site_source): the company's site,
 * the meeting's own typed address, a manager's pin, or the rep's walk-in position.
 */
export type SiteSource = 'company' | 'address' | 'pin' | 'walk_in';

export type Site = {
  address: string | null;
  lat: number | null;
  lng: number | null;
  geocodeStatus: GeocodeStatus;
  /** Null for no site (virtual, or physical with neither address nor company). */
  siteSource: SiteSource | null;
};

/** A geocode verdict obtained before the write transaction. `store` = fresh from the provider. */
export type PreGeocode = { address: string; result: GeocodeResult; store: boolean } | null;

const companyHasPoint = (c: Company | null): c is Company & { lat: number; lng: number } =>
  !!c && c.lat !== null && c.lng !== null;

export { companyGeocodeLine, isCompanyAddress };

/** The address siteFor would geocode, or null when it copies the company site or has no address. */
export function geocodeTarget(address: string | null, company: Company | null): string | null {
  const addr = address ?? companyGeocodeLine(company);
  if (companyHasPoint(company) && isCompanyAddress(addr, company)) return null;
  return addr || null;
}

/** Inside the planning read transaction: a cached verdict for `target`, if any. */
export async function lookupPre(tx: Tx, tenantId: string, target: string | null): Promise<PreGeocode> {
  if (!target) return null;
  const hit = await geocodeLookup(tx, tenantId, target);
  return hit ? { address: target, result: hit, store: false } : null;
}

/** Outside any transaction: call the provider on a cache miss. A throw is not cached. */
export async function fetchPre(target: string | null, cached: PreGeocode, maps: MapsProvider): Promise<PreGeocode> {
  if (!target) return null;
  if (cached) return cached;
  try {
    return { address: target, result: await maps.geocode(target), store: true };
  } catch {
    return { address: target, result: { status: 'failed' }, store: false };
  }
}

/**
 * A company's point and status from a pre-fetched verdict for its geocode line,
 * inside the write transaction (stores fresh provider verdicts; never the
 * network). Null target = no address: no point. `pending` (no key, timeout)
 * leaves the point empty; coordinates are never invented.
 */
export async function companySiteFromPre(
  tx: Tx,
  tenantId: string,
  target: string | null,
  pre: PreGeocode,
  providerName: string,
): Promise<{ lat: number | null; lng: number | null; geocodeStatus: GeocodeStatus | null }> {
  if (!target) return { lat: null, lng: null, geocodeStatus: null };
  if (pre && pre.result.status === 'ok' && pre.result.point) {
    if (pre.store) await geocodeStore(tx, tenantId, pre.address, pre.result, providerName);
    return { lat: pre.result.point.lat, lng: pre.result.point.lng, geocodeStatus: 'ok' };
  }
  const failed = pre?.result.status === 'failed';
  if (pre?.store && failed) await geocodeStore(tx, tenantId, pre.address, pre.result, providerName);
  return { lat: null, lng: null, geocodeStatus: failed ? 'failed' : 'pending' };
}

function fromResult(address: string, r: GeocodeResult, siteSource: SiteSource): Site {
  if (r.status === 'ok' && r.point) return { address, lat: r.point.lat, lng: r.point.lng, geocodeStatus: 'ok', siteSource };
  return { address, lat: null, lng: null, geocodeStatus: r.status === 'pending' ? 'pending' : 'failed', siteSource };
}

/**
 * Site for a physical meeting, inside the write transaction: the company's
 * coordinates (manual pins included) when the address is the company's own,
 * else the pre-fetched geocode. Never calls the network.
 */
export async function siteFor(
  tx: Tx,
  tenantId: string,
  address: string | null,
  company: Company | null,
  pre: PreGeocode,
  providerName: string,
  now: () => Date,
): Promise<Site> {
  const addr = address ?? companyGeocodeLine(company);
  const inherited = isCompanyAddress(addr, company);
  if (companyHasPoint(company) && inherited) {
    return {
      address: addr,
      lat: company.lat,
      lng: company.lng,
      geocodeStatus: company.geocodeStatus ?? 'ok',
      siteSource: 'company',
    };
  }
  // The company's line without a company point yet is still the company's site (geocoded below).
  const source: SiteSource = inherited ? 'company' : 'address';
  if (!addr) return { address: null, lat: null, lng: null, geocodeStatus: 'pending', siteSource: company ? 'company' : null };
  if (pre && pre.address === addr) {
    if (pre.store) await geocodeStore(tx, tenantId, addr, pre.result, providerName, { now });
    return fromResult(addr, pre.result, source);
  }
  // The row changed between planning and locking: use the cache, never the network, under the lock.
  const hit = await geocodeLookup(tx, tenantId, addr);
  return hit ? fromResult(addr, hit, source) : { address: addr, lat: null, lng: null, geocodeStatus: 'pending', siteSource: source };
}

/** A Google Maps link (short links resolved server-side) or "lat, lng" → a point. */
export async function resolvePin(input: string, maps: MapsProvider): Promise<LatLng> {
  const bad = () => new FieldError('validation', 'Paste a Google Maps link or "lat, lng"');
  if (typeof input !== 'string' || input.length > 2000) throw bad();
  const parsed = parseSiteInput(input);
  if (!parsed) throw bad();
  if (parsed.kind === 'point') return parsed.point;
  const resolved = await maps.resolveShortUrl(parsed.url);
  const again = resolved ? parseSiteInput(resolved) : null;
  if (again?.kind !== 'point') throw bad();
  return again.point;
}
