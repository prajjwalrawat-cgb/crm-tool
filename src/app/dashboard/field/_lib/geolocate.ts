/**
 * One-shot browser geolocation for check-in / check-out / walk-in. There is no
 * tracking: the position is read only when the rep taps a button.
 */

export type GeoPosition = { lat: number; lng: number; accuracyM: number };

/** Readings worse than this get a "move outdoors or retry" warning. */
export const LOW_ACCURACY_M = 100;

export const isLowAccuracy = (accuracyM: number): boolean => accuracyM > LOW_ACCURACY_M;

/** Friendly text for a GeolocationPositionError code (1 denied, 2 unavailable, 3 timeout). */
export function geoErrorMessage(code: number): string {
  switch (code) {
    case 1:
      return 'Location permission is off. Allow location for this site in your browser settings, then retry.';
    case 3:
      return 'Getting your location took too long. Move to an open area and retry.';
    case 2:
    default:
      return 'Your phone could not find your location. Turn on GPS / location services and retry.';
  }
}

/** Rejects with an `Error` whose message is safe to show the rep. */
export function geolocate(): Promise<GeoPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('This browser cannot share your location. Try Chrome or Safari on your phone.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      (err) => reject(new Error(geoErrorMessage(err.code))),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}
