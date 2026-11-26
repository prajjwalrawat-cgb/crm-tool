import type { LatLng } from '../types';
import { estimateDriveMinutes } from '../geo';
import { resolveRedirect, type DriveResult, type FetchLike, type GeocodeResult, type MapsProvider } from './types';

type GeocodeResponse = {
  status?: string;
  results?: Array<{ formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }>;
};
type MatrixResponse = {
  status?: string;
  rows?: Array<{
    elements?: Array<{ status?: string; duration?: { value: number }; duration_in_traffic?: { value: number } }>;
  }>;
};

const GOOGLE_TIMEOUT_MS = 4000;

export class GoogleProvider implements MapsProvider {
  readonly name = 'google';
  private readonly fetchFn: FetchLike;
  constructor(private readonly apiKey: string, fetchFn?: FetchLike) {
    this.fetchFn = fetchFn ?? ((u, i) => fetch(u, i));
  }

  /** Bounded: these calls can run inside a DB transaction (walk-in, day view). */
  private async json<T>(url: string): Promise<T> {
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`maps http ${res.status}`);
    return (await res.json()) as T;
  }

  async geocode(address: string): Promise<GeocodeResult> {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json?' +
      new URLSearchParams({ address, region: 'in', key: this.apiKey }).toString();
    let data: GeocodeResponse;
    try {
      data = await this.json<GeocodeResponse>(url);
    } catch {
      return { status: 'pending' }; // transient: retry later, do not cache
    }
    if (data.status === 'ZERO_RESULTS') return { status: 'failed' };
    const loc = data.results?.[0]?.geometry?.location;
    if (data.status === 'OK' && loc) return { status: 'ok', point: { lat: loc.lat, lng: loc.lng } };
    return { status: 'pending' }; // quota / denied / unknown: not a verdict on the address
  }

  async reverseGeocode(p: LatLng): Promise<string> {
    const fallback = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json?' +
      new URLSearchParams({ latlng: `${p.lat},${p.lng}`, key: this.apiKey }).toString();
    try {
      const data = await this.json<GeocodeResponse>(url);
      return (data.status === 'OK' && data.results?.[0]?.formatted_address) || fallback;
    } catch {
      return fallback;
    }
  }

  async driveMinutes(a: LatLng, b: LatLng, departAt: Date): Promise<DriveResult> {
    // Google rejects departure_time in the past.
    const unix = Math.max(Math.floor(departAt.getTime() / 1000), Math.floor(Date.now() / 1000));
    const url =
      'https://maps.googleapis.com/maps/api/distancematrix/json?' +
      new URLSearchParams({
        origins: `${a.lat},${a.lng}`,
        destinations: `${b.lat},${b.lng}`,
        departure_time: String(unix),
        traffic_model: 'best_guess',
        key: this.apiKey,
      }).toString();
    try {
      const data = await this.json<MatrixResponse>(url);
      const el = data.rows?.[0]?.elements?.[0];
      const secs = el?.status === 'OK' ? (el.duration_in_traffic?.value ?? el.duration?.value) : undefined;
      if (typeof secs === 'number') return { minutes: secs / 60, estimate: false };
    } catch {
      /* fall through to the estimator */
    }
    return { minutes: estimateDriveMinutes(a, b), estimate: true };
  }

  resolveShortUrl(url: string): Promise<string | null> {
    return resolveRedirect(this.fetchFn, url);
  }
}
