import 'server-only';

import type { Company } from '@/db/schema';
import type { GeocodeStatus } from '@/db/schema/enums';

import { parseSiteInput } from './geo';
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

export type Site = { address: string | null; lat: number | null; lng: number | null; geocodeStatus: GeocodeStatus };

/** A geocode verdict obtained before the write transaction. `store` = fresh from the provider. */
export type PreGeocode = { address: string; result: GeocodeResult; store: boolean } | null;

const companyHasPoint = (c: Company | null): c is Company & { lat: number; lng: number } =>
  !!c && c.lat !== null && c.lng !== null;

type CompanyAddress = Pick<Company, 'address' | 'city' | 'state' | 'postalCode'>;

/**
 * The single line sent to the geocoder for a company, and the address a meeting
 * inherits from it: street, city, state, postal code. Null when all are blank.
 */
export function companyGeocodeLine(c: CompanyAddress | null | undefined): string | null {
  if (!c) return null;
  const line = [c.address, c.city, c.state, c.postalCode]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(', ');
  return line || null;
}

/** The meeting's address is the company's own (full line, or the street line older rows carry). */
const isCompanyAddress = (addr: string | null, c: Company) =>
  addr === null || addr === companyGeocodeLine(c) || addr === c.address;

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

function fromResult(address: string, r: GeocodeResult): Site {
  if (r.status === 'ok' && r.point) return { address, lat: r.point.lat, lng: r.point.lng, geocodeStatus: 'ok' };
  return { address, lat: null, lng: null, geocodeStatus: r.status === 'pending' ? 'pending' : 'failed' };
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
  if (companyHasPoint(company) && isCompanyAddress(addr, company)) {
    return { address: addr, lat: company.lat, lng: company.lng, geocodeStatus: company.geocodeStatus ?? 'ok' };
  }
  if (!addr) return { address: null, lat: null, lng: null, geocodeStatus: 'pending' };
  if (pre && pre.address === addr) {
    if (pre.store) await geocodeStore(tx, tenantId, addr, pre.result, providerName, { now });
    return fromResult(addr, pre.result);
  }
  // The row changed between planning and locking: use the cache, never the network, under the lock.
  const hit = await geocodeLookup(tx, tenantId, addr);
  return hit ? fromResult(addr, hit) : { address: addr, lat: null, lng: null, geocodeStatus: 'pending' };
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
