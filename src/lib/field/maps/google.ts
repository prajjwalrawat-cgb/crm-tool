import type { LatLng } from '../types';
import { estimateDriveMinutes } from '../geo';
import { resolveRedirect, type DriveResult, type FetchLike, type GeocodeResult, type MapsProvider } from './types';

type GeocodeResponse = {
  status?: string;
  results?: Array<{ formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }>;
};
/** Routes API computeRoutes, field mask `routes.duration` (e.g. "1500s"). */
type RoutesResponse = { routes?: Array<{ duration?: string }> };

const GOOGLE_TIMEOUT_MS = 4000;
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

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

  /**
   * Routes API (computeRoutes) — the legacy Distance Matrix is not available to
   * newer Google Cloud projects. The key goes in a header, never the URL.
   */
  async driveMinutes(a: LatLng, b: LatLng, departAt: Date): Promise<DriveResult> {
    // Traffic-aware routing rejects departure times in the past: use the later of
    // the requested time and a moment from now (whole seconds).
    const floorS = (ms: number) => Math.floor(ms / 1000) * 1000;
    const departMs = Math.max(floorS(departAt.getTime()), floorS(Date.now() + 60_000));
    const point = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    try {
      const res = await this.fetchFn(ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': 'routes.duration',
        },
        body: JSON.stringify({
          origin: point(a),
          destination: point(b),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          departureTime: new Date(departMs).toISOString(),
        }),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as RoutesResponse;
        const m = /^(\d+(?:\.\d+)?)s$/.exec(data.routes?.[0]?.duration ?? '');
        if (m) return { minutes: Number(m[1]) / 60, estimate: false };
      }
    } catch {
      /* fall through to the estimator */
    }
    return { minutes: estimateDriveMinutes(a, b), estimate: true };
  }

  resolveShortUrl(url: string): Promise<string | null> {
    return resolveRedirect(this.fetchFn, url);
  }
}
