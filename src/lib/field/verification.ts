import type { VisitVerifiedHow } from '@/db/schema/field';

/**
 * Words for a visit's verification state (meetings.visit_verified*), shared by
 * the rep card, the manager panel and the board block. Pure; no server imports.
 */

export type VisitVerification = {
  visitVerified: boolean;
  visitVerifiedHow: VisitVerifiedHow | null;
  visitVerifiedAt: Date | string | null;
};

/** After check-in: the visit's verification state is worth showing. */
export const isVisited = (status: string): boolean =>
  status === 'checked_in' || status === 'checked_out' || status === 'mom_logged';

/** Manager panel header chip: "Verified" / "Verified on arrival" / "Verified at check-out" / "Not verified". */
export function visitVerificationLabel(v: Pick<VisitVerification, 'visitVerified' | 'visitVerifiedHow'>): string {
  if (!v.visitVerified) return 'Not verified';
  if (v.visitVerifiedHow === 'on_arrival') return 'Verified on arrival';
  if (v.visitVerifiedHow === 'at_checkout') return 'Verified at check-out';
  return 'Verified';
}

/**
 * The rep card's suffix after "Checked in {time}": "not verified",
 * "verified on arrival 1:20 pm", "verified at check-out 2:05 pm" or "verified".
 * `time` formats an instant in the tenant's time zone.
 */
export function visitVerificationSuffix(v: VisitVerification, time: (d: Date | string) => string): string {
  if (!v.visitVerified) return 'not verified';
  const at = v.visitVerifiedAt ? ` ${time(v.visitVerifiedAt)}` : '';
  if (v.visitVerifiedHow === 'on_arrival') return `verified on arrival${at}`;
  if (v.visitVerifiedHow === 'at_checkout') return `verified at check-out${at}`;
  return 'verified';
}

/** "Verify location" is offered on a checked-in, unverified, physical meeting whose site is located. */
export function canVerifyLocation(m: {
  type: string;
  status: string;
  visitVerified: boolean;
  lat: number | null;
  lng: number | null;
}): boolean {
  return m.type === 'physical' && m.status === 'checked_in' && !m.visitVerified && m.lat !== null && m.lng !== null;
}

const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** The rep's inline message after a 422 outside_radius on Verify location. */
export function verifyTooFarText(distanceM: number, radiusM: number): string {
  return `Still ${fmtM(distanceM)} from the site (limit ${fmtM(radiusM)}). Move closer and try again.`;
}

/** Title of a `kind = 'verify'` row in the manager's check-in trail. */
export function verifyAttemptTitle(c: { accepted: boolean }): string {
  return c.accepted ? 'Location verified' : 'Verification failed';
}
