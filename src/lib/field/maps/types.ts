import type { LatLng } from '../types';

export type GeocodeResult = { status: 'ok' | 'failed' | 'pending'; point?: LatLng };
export type DriveResult = { minutes: number; estimate: boolean };

export interface MapsProvider {
  name: string;
  geocode(address: string): Promise<GeocodeResult>;
  reverseGeocode(p: LatLng): Promise<string>;
  driveMinutes(a: LatLng, b: LatLng, departAt: Date): Promise<DriveResult>;
  resolveShortUrl(url: string): Promise<string | null>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SHORT_HOSTS = new Set(['goo.gl', 'maps.app.goo.gl', 'g.co']);
const GOOGLE_HOST = /^(?:(?:www|maps)\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;
const isGoogleHost = (h: string) => h === 'google.com' || GOOGLE_HOST.test(h);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseHttps(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Follow one hop of a Google short link and return its Location header.
 * Guarded against SSRF: https only, input host allowlisted, output must be a Google host.
 */
export async function resolveRedirect(fetchFn: FetchLike, url: string): Promise<string | null> {
  const u = parseHttps(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const allowed = SHORT_HOSTS.has(host) || (isGoogleHost(host) && u.pathname.startsWith('/maps'));
  if (!allowed) return null;
  try {
    const res = await fetchFn(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    if (!REDIRECT_STATUSES.has(res.status)) return null;
    const loc = res.headers.get('location');
    if (!loc) return null;
    const target = parseHttps(new URL(loc, u).toString());
    if (!target || !isGoogleHost(target.hostname.toLowerCase())) return null;
    return target.toString();
  } catch {
    return null;
  }
}
