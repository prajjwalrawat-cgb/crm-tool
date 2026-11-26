import type { GeocodeStatus } from '@/db/schema/enums';

import { companyGeocodeLine, normAddr } from './site-line';

/**
 * Pure, client-safe: the shapes /api/field/pickers returns and how picking a
 * deal, company or contact in the meeting form links the other two.
 */

export type PickerKind = 'deal' | 'company' | 'contact';

/** A company with what the meeting form needs to prefill and explain the site. */
export type PickerCompany = {
  id: string;
  name: string;
  city: string | null;
  /** companyGeocodeLine: the address a meeting inherits. */
  siteLine: string | null;
  /** Street line alone (older meetings carry it as their address). */
  street: string | null;
  geocodeStatus: GeocodeStatus | null;
  located: boolean;
};

export type PickerChoice = {
  id: string;
  label: string;
  sublabel?: string | null;
  /** The record's company (deal, contact), or the company itself. */
  companyId?: string | null;
  company?: PickerCompany | null;
  /** Deals only: the deal's contact. */
  contact?: PickerChoice | null;
};

export type PickerResponse = { items: PickerChoice[] };

export type Links = { deal: PickerChoice | null; company: PickerChoice | null; contact: PickerChoice | null };

export type LinkResult = {
  links: Links;
  /** A short sentence for the user when a pick replaced or cleared another link. */
  notice: string | null;
  /** True when the company link changed (the form re-prefills the address). */
  companyChanged: boolean;
};

const companyChoice = (c: PickerCompany): PickerChoice => ({
  id: c.id,
  label: c.name,
  sublabel: c.city,
  companyId: c.id,
  company: c,
});

/** The record belongs to a company other than `companyId` (records with no company never conflict). */
const foreign = (x: PickerChoice | null, companyId: string): boolean => !!x?.companyId && x.companyId !== companyId;

/**
 * Picking (or clearing, `item` null) one link:
 *   deal    → its company replaces the chosen one (with a notice when different), its contact fills in;
 *             a contact from another company is cleared
 *   company → a contact or deal that belongs to another company is cleared
 *   contact → fills the company when none is chosen
 */
export function applyPick(cur: Links, kind: PickerKind, item: PickerChoice | null): LinkResult {
  const links: Links = { ...cur, [kind]: item };
  const notes: string[] = [];
  let companyChanged = false;
  const setCompany = (c: PickerCompany) => {
    if (links.company?.id === c.id) return;
    links.company = companyChoice(c);
    companyChanged = true;
  };

  if (kind === 'company') {
    companyChanged = (cur.company?.id ?? null) !== (item?.id ?? null);
    if (item) {
      if (foreign(links.contact, item.id)) {
        notes.push(`Contact ${links.contact!.label} cleared: they belong to another company.`);
        links.contact = null;
      }
      if (foreign(links.deal, item.id)) {
        notes.push(`Deal ${links.deal!.label} cleared: it belongs to another company.`);
        links.deal = null;
      }
    }
  } else if (kind === 'deal' && item) {
    if (item.company) {
      if (cur.company && cur.company.id !== item.company.id) {
        notes.push(`Company changed to ${item.company.name} to match the deal.`);
      }
      setCompany(item.company);
    }
    if (item.contact) links.contact = item.contact;
    else if (item.company && foreign(links.contact, item.company.id)) {
      notes.push(`Contact ${links.contact!.label} cleared: they belong to another company.`);
      links.contact = null;
    }
  } else if (kind === 'contact' && item) {
    if (!links.company && item.company) setCompany(item.company);
  }
  return { links, notice: notes.length ? notes.join(' ') : null, companyChanged };
}

/** What the address box is checked against, in words, for the status line under it. */
export type SiteCheck =
  | { kind: 'company'; text: string }
  | { kind: 'own'; text: string }
  | { kind: 'none'; text: null };

export function companySiteState(c: Pick<PickerCompany, 'geocodeStatus' | 'located'>): 'pinned' | 'located' | 'not located yet' {
  if (c.located && c.geocodeStatus === 'manual') return 'pinned';
  if (c.located) return 'located';
  return 'not located yet';
}

/**
 * Mirrors the server (siteFor): an address equal to the company's line (or blank)
 * uses the company's site; anything else is the meeting's own address.
 */
export function siteCheck(address: string, company: PickerCompany | null): SiteCheck {
  if (!company) return { kind: 'none', text: null };
  if (sameAsCompany(address, company))return { kind: 'company', text: `Checked against: company site (${companySiteState(company)})` };
  return { kind: 'own', text: 'This meeting will be checked against this address instead of the company site.' };
}

/** Same rule as isCompanyAddress, over a PickerCompany (blank, full line, or street line). */
export function sameAsCompany(address: string, company: Pick<PickerCompany, 'siteLine' | 'street'>): boolean {
  const a = normAddr(address);
  return a === '' || a === normAddr(company.siteLine) || (!!company.street?.trim() && a === normAddr(company.street));
}

/** A PickerCompany from a company row's address block and point (server or day view). */
export function toPickerCompany(c: {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  geocodeStatus: GeocodeStatus | null;
}): PickerCompany {
  return {
    id: c.id,
    name: c.name,
    city: c.city,
    siteLine: companyGeocodeLine(c),
    street: c.address,
    geocodeStatus: c.geocodeStatus,
    located: c.lat !== null && c.lng !== null,
  };
}
