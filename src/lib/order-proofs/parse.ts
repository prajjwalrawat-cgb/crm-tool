import type { OrderProofAiRead } from './types';

/**
 * Reading a PO from its text, by its labels (0071). Pure: takes the PDF's
 * text already laid out as lines (read.ts does that) and finds the PO number,
 * date, buyer, currency and the values before and after tax.
 *
 * Built for the POs Indian B2B clients send — Tally / SAP / Zoho / Word
 * exports: day-first dates, lakh grouping (4,00,000.00), CGST + SGST or IGST
 * lines. Anything it can't find is left null for the rep to type in; it never
 * guesses a value it didn't see next to a label.
 */

export const PDF_READER_ID = 'pdf-text-v1';

/** A run of text on one line; a wide gap starts a new segment (a new column). */
export type TextSegment = { x: number; text: string };
export type TextLine = { segments: TextSegment[] };

type Found = { value: number; line: number };

/* ── Numbers ─────────────────────────────────────────────── */

// A money figure: 4,00,000.00 · 400000 · ₹ 4,00,000/- · Rs.400000 — not a
// percentage (9%), not part of a date (03-11-2026) or an id (27AAAAA0000A1Z5).
const MONEY_RE =
  /(?<![\w.,/-])(?:₹|Rs\.?|INR|USD|US\$|\$|€|EUR|£|GBP)?\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s?\/-)?(?![\d,.%/\w-])/gi;

function moneyIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const n = Number(m[1]!.replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * The amount a label refers to: the right-most figure after it on the same
 * line (the amount column), else the right-most figure on the next line.
 */
function amountAfter(lines: TextLine[], li: number, si: number, labelEnd: number): number | null {
  const line = lines[li]!;
  const after = [
    line.segments[si]!.text.slice(labelEnd),
    ...line.segments.slice(si + 1).map((s) => s.text),
  ];
  const same = after.flatMap(moneyIn);
  if (same.length > 0) return same[same.length - 1]!;
  const next = lines[li + 1];
  if (!next || next.segments.some((s) => /[a-z]{3,}/i.test(s.text.replace(MONEY_RE, '')))) return null;
  const below = next.segments.flatMap((s) => moneyIn(s.text));
  return below.length > 0 ? below[below.length - 1]! : null;
}

/** The first line whose segment matches one of `patterns` (in priority order) and carries an amount. */
function findAmount(
  lines: TextLine[],
  patterns: RegExp[],
  skip: (text: string) => boolean = () => false,
): Found | null {
  for (const re of patterns) {
    for (let li = 0; li < lines.length; li++) {
      const segs = lines[li]!.segments;
      for (let si = 0; si < segs.length; si++) {
        const text = segs[si]!.text;
        if (skip(text)) continue;
        const m = re.exec(text);
        if (!m) continue;
        const value = amountAfter(lines, li, si, m.index + m[0].length);
        if (value != null) return { value, line: li };
      }
    }
  }
  return null;
}

/* ── Labels ──────────────────────────────────────────────── */

const SUBTOTAL_RES = [
  /\bsub[\s-]?total\b/i,
  /\btaxable\s+(?:value|amount)\b/i,
  /\b(?:total|amount|value)\s+(?:before|excl(?:uding|\.)?|exclusive\s+of|w\/o)\s*(?:tax|taxes|gst)/i,
  /\b(?:po|order)\s+value\s*\(?\s*excl/i,
  /\bbasic\s+(?:value|amount)\b/i,
  /\bnet\s+(?:value|amount)\b(?!\s+payable)/i,
];

const TOTAL_RES = [
  /\bgrand\s+total\b/i,
  /\btotal\s+(?:amount\s+|value\s+)?(?:payable|incl(?:uding|\.)?|inclusive|with\s+(?:tax|gst))/i,
  /\bnet\s+(?:amount\s+)?payable\b/i,
  /\b(?:total\s+)?(?:po|order)\s+(?:value|amount|total)\b(?!\s*\(?\s*excl)/i,
  /\btotal\s+amount\b/i,
];

/** A plain "Total" row — pre-tax or grand total depending on where it sits. */
const PLAIN_TOTAL_RE = /^\s*total\b(?!\s*(?:tax|gst|qty|quantity|units?|items?|discount))/i;

const TAX_TOTAL_RES = [
  /\btotal\s+(?:tax|gst|taxes)\b/i,
  /\b(?:tax|gst)\s+(?:amount|total)\b/i,
];
const TAX_LINE_RE = /\b(?:c|s|i|ut)?gst\b|\bvat\b|\bcess\b|\btax\b/i;
const NOT_TAX_RE =
  /gstin|gst\s*(?:no|number|reg)|tax\s*(?:id|no|invoice)|\bpan\b|before\s+tax|excl|incl|inclusive|taxable|sub[\s-]?total|grand\s+total|\bhsn\b|\bsac\b|payable/i;

const REF_RES = [
  /\b(?:p\.?\s?o\.?|purchase\s+order)\s*(?:no\.?|number|num|#|ref(?:erence)?(?:\s+no\.?)?)?\s*[:.#-]\s*/i,
  /\b(?:p\.?\s?o\.?|purchase\s+order)\s*(?:no\.?|number|num|#)\s*/i,
  /\b(?:work\s+order|w\.?\s?o\.?|order|contract|agreement|loi)\s*(?:no\.?|number|num|#|ref(?:erence)?)\s*[:.#-]?\s*/i,
];
const REF_VALUE_RE = /^([A-Za-z0-9][A-Za-z0-9/_.-]*\d[A-Za-z0-9/_.-]*)/;

const DATE_LABEL_RE = /\b(?:(?:p\.?\s?o\.?|purchase\s+order|order|document|issue)\s+)?date[d]?\b\s*[:.-]?\s*/i;
const NOT_PO_DATE_RE = /deliver|due|dispatch|expir|valid|invoice|quotation|quote|ship|required|completion/i;

const BUYER_LABEL_RE =
  /\b(?:buyer|bill(?:ed)?\s+to|purchaser|customer|client|issued\s+by|invoice\s+to)\b[^:]*:?\s*/i;
const SUPPLIER_LABEL_RE =
  /\b(?:supplier|vendor|seller)\b(?:\s+(?:name|details|address))?[^:]*:?\s*|^\s*to\s*[:,]?\s*(?=$|m\/s)|^\s*m\/s\.?\s*/i;
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g;
const COMPANY_RE =
  /\b(?:ltd|limited|llp|inc|pvt|private|corp(?:oration)?|company|co\.|industries|enterprises|technologies|solutions|group|gmbh|plc)\b/i;

/* ── Dates ───────────────────────────────────────────────── */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

/** The first date in `text`. Numeric dates are read day-first, as Indian POs print them. */
export function dateIn(text: string): string | null {
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/.exec(text);
  if (m) {
    const [a, b, y] = [+m[1]!, +m[2]!, +m[3]!];
    // Day-first unless that's impossible (05/23/2026 can only be US order).
    return b > 12 && a <= 12 ? isoDate(y, a, b) : isoDate(y, b, a);
  }
  m = /(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3})[a-z]*\.?[\s,-]+(\d{4})/i.exec(text);
  if (m && MONTHS.includes(m[2]!.toLowerCase())) {
    return isoDate(+m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!);
  }
  m = /([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(text);
  if (m && MONTHS.includes(m[1]!.toLowerCase())) {
    return isoDate(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!);
  }
  return null;
}

/* ── Text after a label ──────────────────────────────────── */

/** What follows a label: the rest of its segment, else the next segment on the line. */
function valueAfter(lines: TextLine[], li: number, si: number, end: number): string {
  const segs = lines[li]!.segments;
  const rest = segs[si]!.text.slice(end).trim();
  if (rest) return rest;
  return segs[si + 1]?.text.trim() ?? '';
}

/** The text under a label: the next line's segment that starts near the label's column. */
function valueBelow(lines: TextLine[], li: number, x: number): string {
  for (const next of lines.slice(li + 1, li + 3)) {
    const seg = next.segments.find((s) => Math.abs(s.x - x) < 30);
    if (seg?.text.trim()) return seg.text.trim();
  }
  return '';
}

function eachSegment(lines: TextLine[], fn: (text: string, li: number, si: number, x: number) => string | null) {
  for (let li = 0; li < lines.length; li++) {
    const segs = lines[li]!.segments;
    for (let si = 0; si < segs.length; si++) {
      const found = fn(segs[si]!.text, li, si, segs[si]!.x);
      if (found) return found;
    }
  }
  return null;
}

function referenceIn(lines: TextLine[]): string | null {
  for (const re of REF_RES) {
    const found = eachSegment(lines, (text, li, si) => {
      const m = re.exec(text);
      if (!m) return null;
      const v = REF_VALUE_RE.exec(valueAfter(lines, li, si, m.index + m[0].length));
      return v ? v[1]!.replace(/[.-]+$/, '').slice(0, 120) : null;
    });
    if (found) return found;
  }
  return null;
}

function poDateIn(lines: TextLine[]): string | null {
  return eachSegment(lines, (text, li, si) => {
    const m = DATE_LABEL_RE.exec(text);
    if (!m || NOT_PO_DATE_RE.test(text.slice(0, m.index + m[0].length))) return null;
    return dateIn(valueAfter(lines, li, si, m.index + m[0].length));
  });
}

/** The name after or under a label matched by `re`. */
function labelledName(lines: TextLine[], re: RegExp): string | null {
  return eachSegment(lines, (text, li, si, x) => {
    const m = re.exec(text);
    if (!m) return null;
    const after = text.slice(m.index + m[0].length).trim();
    const value = after && /[a-z]{2,}/i.test(after) ? after : valueBelow(lines, li, x);
    const name = value.replace(/^m\/s\.?\s*/i, '').trim();
    return name && /[a-z]{2,}/i.test(name) ? name.slice(0, 200) : null;
  });
}

/** Who the PO is addressed to: "Supplier:", "Vendor:", "To," / "M/s …". */
function supplierIn(lines: TextLine[]): string | null {
  return labelledName(lines, SUPPLIER_LABEL_RE);
}

function buyerIn(lines: TextLine[], supplier: string | null): string | null {
  const labelled = labelledName(lines, BUYER_LABEL_RE);
  if (labelled) return labelled;
  // POs are printed on the buyer's letterhead: the first company name at the top.
  for (const line of lines.slice(0, 8)) {
    const seg = line.segments.find(
      (s) =>
        COMPANY_RE.test(s.text) &&
        !/supplier|vendor|to:/i.test(s.text) &&
        s.text.trim() !== supplier,
    );
    if (seg) return seg.text.trim().slice(0, 200);
  }
  return null;
}

function currencyIn(text: string): string | null {
  const score: Record<string, number> = {
    INR: (text.match(/₹|\bINR\b|\bRs\.?(?=\s?\d)|rupees|\bGSTIN\b/gi) ?? []).length,
    USD: (text.match(/\bUSD\b|US\$|\$\s?\d|dollars/gi) ?? []).length,
    EUR: (text.match(/€|\bEUR\b|euros?/gi) ?? []).length,
    GBP: (text.match(/£|\bGBP\b|pounds?\s+sterling/gi) ?? []).length,
  };
  const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : null;
}

/* ── The read ────────────────────────────────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseOrderText(lines: TextLine[]): OrderProofAiRead {
  const all = lines.map((l) => l.segments.map((s) => s.text).join('  ')).join('\n');
  const notes: string[] = [];

  let subtotal = findAmount(lines, SUBTOTAL_RES);
  let total = findAmount(lines, TOTAL_RES, (t) => SUBTOTAL_RES.some((re) => re.test(t)));

  // Taxes: an explicit total-tax line, else the sum of the individual tax
  // lines (CGST + SGST, or IGST) between the subtotal and the grand total.
  let tax: number | null = findAmount(lines, TAX_TOTAL_RES)?.value ?? null;
  const taxLines: number[] = [];
  if (tax == null) {
    const from = subtotal?.line ?? -1;
    const to = total?.line ?? lines.length;
    let sum = 0;
    for (let li = from + 1; li < to; li++) {
      const text = lines[li]!.segments.map((s) => s.text).join('  ');
      if (!TAX_LINE_RE.test(text) || NOT_TAX_RE.test(text)) continue;
      const amounts = moneyIn(text);
      if (amounts.length === 0) continue;
      sum += amounts[amounts.length - 1]!;
      taxLines.push(li);
    }
    if (taxLines.length > 0) tax = round2(sum);
  }

  // A plain "Total" row: above the taxes it is the value before tax, below
  // them the grand total.
  if (!subtotal || !total) {
    const firstTax = taxLines[0] ?? Infinity;
    const lastTax = taxLines[taxLines.length - 1] ?? -Infinity;
    for (let li = 0; li < lines.length; li++) {
      const segs = lines[li]!.segments;
      const si = segs.findIndex((s) => PLAIN_TOTAL_RE.test(s.text));
      if (si < 0) continue;
      const m = PLAIN_TOTAL_RE.exec(segs[si]!.text)!;
      const value = amountAfter(lines, li, si, m.index + m[0].length);
      if (value == null) continue;
      if (!subtotal && li < firstTax && taxLines.length > 0) subtotal = { value, line: li };
      else if (!total && li > lastTax) total = { value, line: li };
    }
  }

  // Fill in what the other two figures settle.
  let sub = subtotal?.value ?? null;
  let tot = total?.value ?? null;
  if (sub == null && tot != null && tax != null && tot > tax) {
    sub = round2(tot - tax);
    notes.push('Value before tax worked out as total minus tax');
  }
  if (tax == null && sub != null && tot != null && tot >= sub) tax = round2(tot - sub);
  if (tot == null && sub != null && tax != null) tot = round2(sub + tax);

  const arithmeticOk = sub != null && tot != null && Math.abs(sub + (tax ?? 0) - tot) <= 1;
  if (sub != null && tot != null && !arithmeticOk) {
    notes.push('Value before tax plus tax does not equal the total on this document — check the figures');
  }
  if (/\b(?:freight|shipping|packing|forwarding|transport(?:ation)?)\b/i.test(all) && sub != null) {
    notes.push('Freight or other charges are listed — check they are counted the way the deal value is');
  }

  const isOrder = /purchase\s+order|\bp\.?\s?o\.?\b|work\s+order|order\s+confirmation|letter\s+of\s+intent|\bcontract\b|agreement/i.test(all);
  const looksOther = /\bquotation\b|\bquote\b|\bproforma\b|\binvoice\b/i.test(all);
  if (!isOrder && looksOther) notes.push('This looks like a quotation or invoice, not the client’s order');

  const referenceNo = referenceIn(lines);
  const confidence: OrderProofAiRead['confidence'] =
    !isOrder && looksOther
      ? 'low'
      : referenceNo && sub != null && arithmeticOk
        ? 'high'
        : sub != null
          ? 'medium'
          : 'low';

  const supplierName = supplierIn(lines);
  return {
    model: PDF_READER_ID,
    referenceNo,
    issuedOn: poDateIn(lines),
    buyerName: buyerIn(lines, supplierName),
    currency: currencyIn(all),
    subtotal: sub,
    tax,
    total: tot,
    confidence,
    notes: notes.length > 0 ? notes.join('. ') : null,
    supplierName,
    gstins: [...new Set(all.toUpperCase().match(GSTIN_RE) ?? [])],
    kind: isOrder ? 'order' : looksOther ? 'other' : 'unknown',
  };
}
