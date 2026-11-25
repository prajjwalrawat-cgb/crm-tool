import type { LatLng } from './types';

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Road-distance guess: straight line x 1.4 at 25 km/h average city speed, rounded up. */
export function estimateDriveMinutes(a: LatLng, b: LatLng): number {
  const km = haversineMeters(a, b) / 1000;
  return Math.ceil(((km * 1.4) / 25) * 60 - 1e-9);
}

function validPoint(lat: number, lng: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PAIR = `${NUM}\\s*,\\s*${NUM}`;
const PATTERNS = [
  new RegExp(`@${PAIR}`),
  new RegExp(`[?&]q=${PAIR}`),
  new RegExp(`[?&]query=${PAIR}`),
  new RegExp(`^\\s*${PAIR}\\s*$`),
];

export function parseSiteInput(
  input: string,
): { kind: 'point'; point: LatLng } | { kind: 'short_url'; url: string } | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\/(maps\.app\.goo\.gl\/|goo\.gl\/maps)/i.test(s)) return { kind: 'short_url', url: s };
  for (const re of PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const point = validPoint(Number(m[1]), Number(m[2]));
    return point ? { kind: 'point', point } : null;
  }
  return null;
}
