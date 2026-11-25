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

/** Follow one hop of a short link without downloading the target; returns the Location header. */
export async function resolveRedirect(fetchFn: FetchLike, url: string): Promise<string | null> {
  try {
    const res = await fetchFn(url, { redirect: 'manual' });
    return res.headers.get('location');
  } catch {
    return null;
  }
}
