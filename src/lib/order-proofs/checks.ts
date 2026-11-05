import type { OrderProofAiRead } from './types';

/**
 * Sanity checks on a client PO beyond the amount (0071). The amount match is
 * the hard rule that gates Won (shared.ts); these are WARNINGS: things a
 * person should look at — a PO from another company, addressed to another
 * vendor, dated oddly, that is really a quotation, or whose figures don't add
 * up. The rep must confirm each one to submit the PO, and the confirmation
 * is recorded in the deal's activity.
 *
 * Client- and server-safe: the form shows them live, and the server
 * recomputes them on submit and refuses an unconfirmed one.
 */

export type ProofWarningCode =
  | 'buyer_missing'
  | 'buyer_mismatch'
  | 'supplier_mismatch'
  | 'date_missing'
  | 'date_future'
  | 'date_before_deal'
  | 'date_stale'
  | 'not_an_order'
  | 'totals_mismatch';

export type ProofWarning = { code: ProofWarningCode; message: string };

/** What a PO is checked against — the deal and this workspace's own identity. */
export type ProofCheckContext = {
  /** The deal's company (linked record or free-text name), if any. */
  dealCompany: string | null;
  /** When the deal was created, YYYY-MM-DD. */
  dealCreatedOn: string;
  /** This workspace's names: its own name and its invoice seller names. */
  sellerNames: string[];
  /** This workspace's GSTINs, from its invoice seller profiles. */
  sellerGstins: string[];
};

export type ProofUnderCheck = {
  buyerName: string | null;
  issuedOn: string | null;
  subtotalMinor: number;
  taxMinor: number;
  /** Null when the rep left the total to be value + tax. */
  totalMinor: number | null;
  /** What was read off the file, when it was read (PDFs). */
  read: OrderProofAiRead | null;
};

/** A PO older than this is flagged as stale. */
export const STALE_PO_DAYS = 180;

/** Two figures this close (in minor units) are the same, as in the Won rule. */
const ROUNDING_MINOR = 100;

const LEGAL_WORDS = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'co', 'company',
  'corp', 'corporation', 'the', 'ms', 'india', 'and', 'plc', 'gmbh',
]);

/** A company name reduced to the words that identify it. */
export function companyWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/m\/s\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_WORDS.has(w));
}

/**
 * Whether two names are the same company, forgiving legal suffixes, case and
 * punctuation: "Acme Test Industries Pvt. Ltd." = "ACME TEST INDUSTRIES
 * PRIVATE LIMITED" = "Acme Test Industries".
 */
export function sameCompany(a: string, b: string): boolean {
  const x = companyWords(a);
  const y = companyWords(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const xs = new Set(x);
  const ys = new Set(y);
  const shared = [...xs].filter((w) => ys.has(w)).length;
  // One name is the other with words added ("Acme" ⊂ "Acme Test Industries")…
  if (shared === Math.min(xs.size, ys.size)) return true;
  // …or most words agree.
  return shared / new Set([...xs, ...ys]).size >= 0.6;
}

const normGstin = (g: string) => g.replace(/\s+/g, '').toUpperCase();

function daysBetween(fromIso: string, toIso: string) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function proofWarnings(
  proof: ProofUnderCheck,
  ctx: ProofCheckContext,
  today: string = todayIso(),
): ProofWarning[] {
  const out: ProofWarning[] = [];
  const buyer = proof.buyerName?.trim() || null;

  // The client: the PO must come from the company the deal is with.
  if (ctx.dealCompany) {
    if (!buyer) {
      out.push({
        code: 'buyer_missing',
        message: `The buyer isn't filled in. Check this PO is from ${ctx.dealCompany}.`,
      });
    } else if (!sameCompany(buyer, ctx.dealCompany)) {
      out.push({
        code: 'buyer_mismatch',
        message: `The PO is from "${buyer}", but this deal is with "${ctx.dealCompany}".`,
      });
    }
  }

  // The supplier: the PO must be addressed to us. Only checkable when the
  // reader found who it's addressed to (a PDF), not for typed-in photos.
  const read = proof.read;
  if (read && (ctx.sellerNames.length > 0 || ctx.sellerGstins.length > 0)) {
    const ours = new Set(ctx.sellerGstins.map(normGstin));
    const gstins = (read.gstins ?? []).map(normGstin);
    const gstinOurs = gstins.some((g) => ours.has(g));
    const supplier = read.supplierName?.trim() || null;
    const nameOurs = supplier ? ctx.sellerNames.some((n) => sameCompany(supplier, n)) : false;
    // A PO usually carries the buyer's GSTIN and the supplier's: two or more
    // with none of ours means it names some other vendor.
    const otherGstins = ours.size > 0 && gstins.length >= 2 && !gstinOurs;
    if (!gstinOurs && !nameOurs && ((supplier && ctx.sellerNames.length > 0) || otherGstins)) {
      out.push({
        code: 'supplier_mismatch',
        message: supplier
          ? `The PO is addressed to "${supplier}", not to ${ctx.sellerNames[0] ?? 'your company'}.`
          : `None of the GSTINs on the PO is yours. Check the PO is addressed to ${ctx.sellerNames[0] ?? 'your company'}.`,
      });
    }
  }

  // The date.
  if (!proof.issuedOn) {
    out.push({ code: 'date_missing', message: 'The PO date isn\'t filled in.' });
  } else if (proof.issuedOn > today) {
    out.push({ code: 'date_future', message: `The PO is dated ${proof.issuedOn}, which is in the future.` });
  } else {
    if (daysBetween(proof.issuedOn, today) > STALE_PO_DAYS) {
      out.push({
        code: 'date_stale',
        message: `The PO is dated ${proof.issuedOn}, more than ${STALE_PO_DAYS / 30} months ago.`,
      });
    }
    if (proof.issuedOn < ctx.dealCreatedOn) {
      out.push({
        code: 'date_before_deal',
        message: `The PO (${proof.issuedOn}) is older than this deal, which was created on ${ctx.dealCreatedOn}.`,
      });
    }
  }

  // The kind of document.
  if (read?.kind === 'other') {
    out.push({
      code: 'not_an_order',
      message: 'This document reads like a quotation or an invoice, not the client\'s order.',
    });
  }

  // The figures.
  if (proof.totalMinor != null && Math.abs(proof.subtotalMinor + proof.taxMinor - proof.totalMinor) > ROUNDING_MINOR) {
    out.push({
      code: 'totals_mismatch',
      message: 'The value before tax plus the tax does not equal the total.',
    });
  }

  return out;
}
