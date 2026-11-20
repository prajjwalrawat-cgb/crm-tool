/**
 * Shared render input, theme-derived styles and formatters for the quote
 * PDF section renderers.
 */
import { gstStateCode, partyStateCode } from '@/lib/invoices/gst';
import type { PdfParty } from '@/lib/invoices/types';

import type { Placeholder, QuoteTemplateBody, QuoteTheme } from '../template-schema';
import type { QuoteDetail } from '../types';
import { quoteFontFamily } from './fonts';

export type QuoteRenderInput = {
  body: QuoteTemplateBody;
  quote: QuoteDetail;
  logoUrl: string | null;
  placeholderValues: Partial<Record<Placeholder, string | null>>;
  /** custom_fields sections read dealCustomFields[key]; missing → '—'. */
  dealCustomFields: Record<string, unknown>;
};

export type RenderContext = QuoteRenderInput & { styles: QuoteStyles };

export const MM = 72 / 25.4;

export function makeStyles(theme: QuoteTheme) {
  const fs = theme.baseFontSize;
  return {
    page: {
      fontFamily: quoteFontFamily(theme.fontFamily),
      fontSize: fs,
      color: '#111827',
      padding: theme.marginsMm * MM,
      paddingBottom: theme.marginsMm * MM + fs * 2,
      // Ligature glyphs ("fi") copy/extract as missing letters ("fnd").
      fontFeatureSettings: { liga: false },
      // No page-level lineHeight: react-pdf resolves it to points against the
      // page font size and children inherit that fixed value (larger text
      // overlaps), and it also drops fixed `render` text (the page footer).
    },
    section: { marginBottom: fs * 1.4 },
    sectionTitle: { fontSize: fs * 1.15, fontWeight: 700, color: theme.primaryColor, marginBottom: fs * 0.5 },
    h2: { fontSize: fs * 1.3, fontWeight: 700, color: theme.primaryColor, marginTop: fs * 0.4, marginBottom: fs * 0.3 },
    h3: { fontSize: fs * 1.12, fontWeight: 700, color: theme.primaryColor, marginTop: fs * 0.3, marginBottom: fs * 0.25 },
    paragraph: { marginBottom: fs * 0.35 },
    muted: { color: '#6b7280' },
    bold: { fontWeight: 700 },
    label: { fontSize: fs * 0.85, color: '#6b7280', textTransform: 'uppercase' as const, marginBottom: 2 },
    title: { fontSize: fs * 2, fontWeight: 700, color: theme.accentColor },
    tableHeader: { flexDirection: 'row' as const, backgroundColor: theme.primaryColor, color: '#ffffff', fontWeight: 700 },
    tableRow: { flexDirection: 'row' as const, borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb' },
    cell: { paddingVertical: 4, paddingHorizontal: 4 },
    right: { textAlign: 'right' as const },
    accentRule: { borderTopWidth: 1.5, borderTopColor: theme.accentColor },
    footer: {
      position: 'absolute' as const,
      bottom: theme.marginsMm * MM * 0.5,
      left: theme.marginsMm * MM,
      right: theme.marginsMm * MM,
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      fontSize: fs * 0.8,
      color: '#9ca3af',
    },
  };
}
export type QuoteStyles = ReturnType<typeof makeStyles>;

export function formatMoney(minor: number): string {
  const s = (Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${minor < 0 ? '-' : ''}₹${s}`;
}

/** Basis points as a percent, up to 3 decimals: 1800 → "18%", 250 → "2.5%", 12.5 → "0.125%" (half of a 0.25% slab). */
export function formatBps(bps: number): string {
  return `${Number((bps / 100).toFixed(3))}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** yyyy-mm-dd → "20 Nov 2026" (unparseable input is returned as-is). */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || m > 12) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** numeric(14,3) string → "2", "1.5" (Indian grouping). */
export function formatQuantity(q: string | number): string {
  const n = Number(q);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 3 }) : String(q);
}

/**
 * The total the PDF prints and splits. With the template's totals section
 * `showRoundOff` on, the payable figure is rounded to the rupee (display
 * only: the stored total_minor stays exact). Totals, amount in words and
 * the payment schedule all use payableMinor so the PDF agrees with itself.
 */
export function grandTotalForDisplay(input: Pick<QuoteRenderInput, 'body' | 'quote'>): { exactMinor: number; roundOffMinor: number; payableMinor: number } {
  const exactMinor = input.quote.totals.totalMinor;
  const totals = input.body.sections.find((s) => s.type === 'totals');
  const round = totals?.type === 'totals' && totals.settings.showRoundOff;
  const payableMinor = round ? Math.round(exactMinor / 100) * 100 : exactMinor;
  return { exactMinor, roundOffMinor: payableMinor - exactMinor, payableMinor };
}

/** Seller state from its GSTIN; place of supply = consignee, else buyer (as for invoices). */
export function supplyStateCodes(quote: Pick<QuoteDetail, 'seller' | 'buyer' | 'consignee'>): { seller: string | null; place: string | null } {
  return {
    seller: gstStateCode(quote.seller.gstin) ?? partyStateCode(quote.seller),
    place: partyStateCode(quote.consignee) ?? partyStateCode(quote.buyer),
  };
}

/** Address block lines for a party (address, city/locality/pincode, state). */
export function partyAddressLines(p: PdfParty): string[] {
  const lines: string[] = [];
  if (p.address) lines.push(...p.address.split(/\r?\n/).filter(Boolean));
  const cityLine = [p.locality, p.city].filter(Boolean).join(', ') + (p.pincode ? ` ${p.pincode}` : '');
  if (cityLine.trim()) lines.push(cityLine.trim());
  if (p.state) lines.push(p.stateCode ? `${p.state} (${p.stateCode})` : p.state);
  return lines;
}
