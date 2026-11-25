import type { LatLng } from '../types';
import { estimateDriveMinutes } from '../geo';
import { resolveRedirect, type DriveResult, type FetchLike, type GeocodeResult, type MapsProvider } from './types';

/** Used when no MAPS_API_KEY: never invents a point; drive times are flagged as estimates. */
export class EstimateProvider implements MapsProvider {
  readonly name = 'estimate';
  private readonly fetchFn: FetchLike;
  constructor(fetchFn?: FetchLike) {
    this.fetchFn = fetchFn ?? ((u, i) => fetch(u, i));
  }

  async geocode(_address: string): Promise<GeocodeResult> {
    return { status: 'pending' };
  }
  async reverseGeocode(p: LatLng): Promise<string> {
    return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  }
  async driveMinutes(a: LatLng, b: LatLng, _departAt: Date): Promise<DriveResult> {
    return { minutes: estimateDriveMinutes(a, b), estimate: true };
  }
  resolveShortUrl(url: string): Promise<string | null> {
    return resolveRedirect(this.fetchFn, url);
  }
}
