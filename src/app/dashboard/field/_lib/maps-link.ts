/**
 * Google Maps directions deep link (opens the Maps app on phones). Pinned
 * coordinates win over the address text. Null when there is nothing to go to.
 */
export function directionsUrl(site: { lat: number | null; lng: number | null; address: string | null }): string | null {
  const base = 'https://www.google.com/maps/dir/?api=1&destination=';
  if (site.lat !== null && site.lng !== null) return `${base}${site.lat},${site.lng}`;
  const address = site.address?.trim();
  return address ? `${base}${encodeURIComponent(address)}` : null;
}
