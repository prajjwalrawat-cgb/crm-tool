/**
 * Pure, client-safe site helpers shared by the meeting service and the meeting
 * form, so "is this the company's address?" is decided the same way on both sides.
 */

export type CompanyAddress = {
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

/**
 * The single line sent to the geocoder for a company, and the address a meeting
 * inherits from it: street, city, state, postal code. Null when all are blank.
 */
export function companyGeocodeLine(c: CompanyAddress | null | undefined): string | null {
  if (!c) return null;
  const line = [c.address, c.city, c.state, c.postalCode]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(', ');
  return line || null;
}

/**
 * The meeting's address is the company's own: blank, the full company line, or
 * the street line alone (older rows). Compared after trimming, like the service's
 * optText. False when there is no company.
 */
export function isCompanyAddress(address: string | null | undefined, company: CompanyAddress | null | undefined): boolean {
  if (!company) return false;
  const a = address?.trim() ?? '';
  if (!a) return true;
  return a === companyGeocodeLine(company) || a === company.address?.trim();
}
