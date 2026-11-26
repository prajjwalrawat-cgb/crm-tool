import { EstimateProvider } from './estimate';
import { GoogleProvider } from './google';
import type { MapsProvider } from './types';

export type { MapsProvider, GeocodeResult, DriveResult } from './types';
export { GoogleProvider } from './google';
export { EstimateProvider } from './estimate';

export function getMapsProvider(): MapsProvider {
  const key = process.env.MAPS_API_KEY;
  return key && key.trim() ? new GoogleProvider(key.trim()) : new EstimateProvider();
}
