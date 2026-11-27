/**
 * The "classic" quote layout: the boxed Indian GST proforma format (the
 * same shape as invoices/pdf.ts), drawn with react-pdf so it shares the
 * quote fonts, money maths and preview pipeline.
 *
 * Sections fill fixed slots instead of stacking in order:
 *   header            → title, logo, seller box, number/date cells
 *   client            → Consignee (Ship to) + Buyer (Bill to) boxes
 *   custom_fields     → extra label/value cells in the right-hand grid
 *   payment_schedule  → "Mode/Terms of Payment" cell (milestones as one line)
 *   terms             → full-width cell under the right-hand grid
 *   line_items        → item table with continuous column rules
 *   totals            → tax / round-off / grand total rows, amount in words,
 *                       HSN-wise tax summary (when showTaxBreakdown)
 *   text              → bottom-left box (e.g. the GST declaration)
 *   signature         → "For <seller> / Authorised Signatory", bottom right
 *   page_break        → ignored
 * A disabled section leaves its slot out.
 */
import type { JSX, ReactNode } from 'react';
import { Document, Image, Page, Text, View } from '@react-pdf/renderer';

import { gstBreakdown } from '@/lib/invoices/gst';
import type { PdfParty } from '@/lib/invoices/types';

import {
  effectiveMilestones,
  effectiveSectionTerms,
  effectiveSectionText,
  resolvePlaceholders,
  type QuoteSection,
} from '../template-schema';
import type { QuoteDetailItem } from '../types';
import { amountInWords } from './amount-in-words';
import {
  formatBps,
  formatDate,
  formatMoney,
  formatQuantity,
  grandTotalForDisplay,
  makeStyles,
  MM,
  partyAddressLines,
  supplyStateCodes,
  type QuoteRenderInput,
  type RenderContext,
} from './context';
import { RichTextPdf } from './rich-text-pdf';
import { display } from './sections/custom-fields';

type Of<T extends QuoteSection['type']> = Extract<QuoteSection, { type: T }>;
type LineItemsSection = Of<'line_items'>;
type ColumnKey = LineItemsSection['settings']['columns'][number]['key'];

const RULE = '#3c3c3c';
const HEAD_BG = '#f0f0f0';
const B = { borderColor: RULE, borderStyle: 'solid' as const };
const bTop = { ...B, borderTopWidth: 0.6 };
const bBottom = { ...B, borderBottomWidth: 0.6 };
const bRight = { ...B, borderRightWidth: 0.6 };

/** Fixed column widths; description takes the rest. */
const WIDTH: Record<Exclude<ColumnKey, 'description'>, string> = {
  sno: '5%',
  hsn_sac: '11%',
  unit: '6%',
  quantity: '9%',
  rate: '12%',
  discount: '7%',
  tax_rate: '7%',
  amount: '15%',
};
const RIGHT = new Set<ColumnKey>(['quantity', 'rate', 'discount', 'tax_rate', 'amount']);
const CENTER = new Set<ColumnKey>(['sno', 'unit']);

function enabled<T extends QuoteSection['type']>(sections: QuoteSection[], type: T): Of<T> | undefined {
  return sections.find((s): s is Of<T> => s.type === type && s.enabled);
}

/** "State Name : Delhi, Code : 07", as on Tally invoices. */
function stateLine(p: PdfParty): string | null {
  if (!p.state) return null;
  return p.stateCode ? `State Name : ${p.state}, Code : ${p.stateCode}` : `State Name : ${p.state}`;
}

function partyLines(p: PdfParty): string[] {
  const lines = partyAddressLines(p).filter((l) => !p.state || !l.startsWith(p.state));
  if (p.gstin) lines.push(`GSTIN/UIN : ${p.gstin}`);
  const st = stateLine(p);
  if (st) lines.push(st);
  return lines;
}

function itemCell(key: ColumnKey, item: QuoteDetailItem, index: number): string {
  switch (key) {
    case 'sno':
      return String(index + 1);
    case 'description':
      return item.description;
    case 'hsn_sac':
      return item.hsnSac ?? '';
    case 'unit':
      return item.unit ?? '';
    case 'quantity':
      return formatQuantity(item.quantity);
    case 'rate':
      return formatMoney(item.rateMinor);
    case 'discount':
      return item.discountBps ? formatBps(item.discountBps) : '';
    case 'tax_rate':
      return formatBps(item.taxRateBps);
    case 'amount':
      return formatMoney(item.totals.amountMinor);
  }
}

/** Milestones as one line: "70% Advance with order, 30% On dispatch". */
export function milestonesLine(milestones: { label: string; percentBps: number }[]): string {
  return milestones.map((m) => `${formatBps(m.percentBps)} ${m.label}`).join(', ');
}

export type HsnRow = { hsn: string; rateBps: number; taxableMinor: number; taxMinor: number };

/** Tax summary rows, one per (HSN/SAC, rate); sums back to the quote totals. */
export function hsnSummary(items: QuoteDetailItem[]): HsnRow[] {
  const rows = new Map<string, HsnRow>();
  for (const it of items) {
    const hsn = it.hsnSac?.trim() || '';
    const key = `${hsn}\u0000${it.taxRateBps}`;
    const r = rows.get(key) ?? { hsn, rateBps: it.taxRateBps, taxableMinor: 0, taxMinor: 0 };
    r.taxableMinor += it.totals.taxableMinor;
    r.taxMinor += it.totals.taxMinor;
    rows.set(key, r);
  }
  return [...rows.values()].filter((r) => r.taxableMinor !== 0);
}

/** Label over value, in a grid cell. */
function Cell({ label, value, fs, last }: { label: string; value?: ReactNode; fs: number; last?: boolean }) {
  return (
    <View style={[{ flex: 1, paddingHorizontal: 3, paddingVertical: 2, minHeight: fs * 2.4 }, last ? {} : bRight]}>
      <Text style={{ fontSize: fs * 0.85, color: '#374151' }}>{label}</Text>
      {typeof value === 'string' ? <Text style={{ fontWeight: 700 }}>{value}</Text> : value}
    </View>
  );
}

export function ClassicQuoteDocument(props: QuoteRenderInput): JSX.Element {
  const { body, quote } = props;
  const ctx: RenderContext = { ...props, styles: makeStyles(body.theme) };
  const { styles } = ctx;
  const fs = body.theme.baseFontSize;
  const small = { fontSize: fs * 0.9 };
  const sections = body.sections;

  const header = enabled(sections, 'header');
  const client = enabled(sections, 'client');
  const lineItems = sections.find((s): s is LineItemsSection => s.type === 'line_items');
  const totals = enabled(sections, 'totals');
  const payment = enabled(sections, 'payment_schedule');
  const terms = enabled(sections, 'terms');
  const signature = enabled(sections, 'signature');
  const customFields = sections.filter((s): s is Of<'custom_fields'> => s.type === 'custom_fields' && s.enabled);
  const texts = sections.filter((s): s is Of<'text'> => s.type === 'text' && s.enabled);

  const seller = quote.seller;
  const title = header?.settings.titleText || 'Quotation';
  const ref = quote.revision > 1 ? `${quote.quoteNumber} Rev ${quote.revision}` : quote.quoteNumber;
  const grand = grandTotalForDisplay(ctx);
  const states = supplyStateCodes(quote);
  const interState = Boolean(states.seller && states.place && states.seller !== states.place);

  /* ---------- Seller ---------- */
  const sellerLines: string[] = [];
  const fields = header?.settings.showSellerFields ?? ['address', 'gstin'];
  if (fields.includes('address')) sellerLines.push(...partyAddressLines(seller).filter((l) => !seller.state || !l.startsWith(seller.state)));
  if (fields.includes('gstin') && seller.gstin) sellerLines.push(`GSTIN/UIN : ${seller.gstin}`);
  if (fields.includes('address') || fields.includes('gstin')) {
    const st = stateLine(seller);
    if (st) sellerLines.push(st);
  }
  if (seller.cin) sellerLines.push(`CIN : ${seller.cin}`);
  const logo =
    header && ctx.logoUrl ? (
      // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
      <Image src={ctx.logoUrl} style={{ height: Math.min(header.settings.logoHeightMm, 20) * MM, maxWidth: 32 * MM, objectFit: 'contain', marginRight: 6 }} />
    ) : null;

  /* ---------- Right-hand meta grid: pairs of cells ---------- */
  const meta: { label: string; value: string }[] = [];
  const metaFields = header?.settings.metaFields ?? ['number', 'date'];
  if (metaFields.includes('number')) meta.push({ label: `${title} No.`, value: quote.revision > 1 ? `${quote.quoteNumber} (Rev ${quote.revision})` : quote.quoteNumber });
  if (metaFields.includes('date')) meta.push({ label: 'Dated', value: formatDate(quote.quoteDate) });
  if (metaFields.includes('valid_until')) meta.push({ label: 'Valid until', value: formatDate(quote.validUntil) });
  if (metaFields.includes('rep') && ctx.placeholderValues['rep.name']) meta.push({ label: 'Prepared by', value: ctx.placeholderValues['rep.name'] });
  for (const cf of customFields) {
    for (const f of cf.settings.fields) {
      const v = display(Object.hasOwn(ctx.dealCustomFields, f.key) ? ctx.dealCustomFields[f.key] : undefined);
      meta.push({ label: f.label || f.key, value: v === '—' ? '' : v });
    }
  }
  const metaRows: { label: string; value: string }[][] = [];
  for (let i = 0; i < meta.length; i += 2) metaRows.push(meta.slice(i, i + 2));

  /* ---------- Item table ---------- */
  const columns = (lineItems?.settings.columns ?? []).filter((c) => c.visible);
  const colStyle = (key: ColumnKey, i: number) => [
    { paddingHorizontal: 3, paddingVertical: 2 },
    key === 'description' ? { flex: 1 } : { width: WIDTH[key] },
    ...(i < columns.length - 1 ? [bRight] : []),
    ...(RIGHT.has(key) ? [styles.right] : CENTER.has(key) ? [{ textAlign: 'center' as const }] : []),
  ];
  /** A full-width table row: `values` by column key; empty cells keep the column rules. */
  const tableRow = (key: string, values: Partial<Record<ColumnKey, string>>, opts: { bold?: boolean; italicLabel?: boolean; top?: boolean } = {}) => (
    <View key={key} style={[{ flexDirection: 'row' }, opts.top ? bTop : {}]} wrap={false}>
      {columns.map((c, i) => (
        <Text
          key={c.key}
          style={[
            ...colStyle(c.key, i),
            ...(opts.bold ? [styles.bold] : []),
            ...(c.key === 'description' && opts.italicLabel ? [{ textAlign: 'right' as const, fontStyle: 'italic' as const }] : []),
          ]}
        >
          {values[c.key] ?? ''}
        </Text>
      ))}
    </View>
  );

  const t = quote.totals;
  const summaryRows: { label: string; minor: number }[] = [];
  if (totals) {
    const hidden = totals.settings.discountDisplay === 'hidden';
    const anyRowsBelow = t.discountMinor > 0 || t.taxMinor > 0 || grand.roundOffMinor !== 0;
    if (totals.settings.showSubtotal && anyRowsBelow) summaryRows.push({ label: 'Total', minor: hidden ? t.taxableMinor : t.subtotalMinor });
    if (totals.settings.discountDisplay === 'combined' && t.discountMinor > 0) summaryRows.push({ label: 'Less: Discount', minor: -t.discountMinor });
    else if (totals.settings.discountDisplay === 'split') {
      if (t.lineDiscountMinor > 0) summaryRows.push({ label: 'Less: Line discounts', minor: -t.lineDiscountMinor });
      if (t.overallDiscountMinor > 0) summaryRows.push({ label: 'Less: Overall discount', minor: -t.overallDiscountMinor });
    }
    if (!hidden && t.discountMinor > 0) summaryRows.push({ label: 'Taxable value', minor: t.taxableMinor });
    if (totals.settings.showTaxBreakdown) {
      for (const g of t.taxGroups) {
        if (g.rateBps === 0) continue;
        const b = gstBreakdown({ sellerStateCode: states.seller, placeStateCode: states.place, taxRate: g.rateBps / 100, taxMinor: g.taxMinor });
        if (b.interState) summaryRows.push({ label: `Output IGST @ ${formatBps(g.rateBps)}`, minor: b.igstMinor });
        else {
          summaryRows.push({ label: `Output CGST @ ${formatBps(g.rateBps / 2)}`, minor: b.cgstMinor });
          summaryRows.push({ label: `Output SGST @ ${formatBps(g.rateBps / 2)}`, minor: b.sgstMinor });
        }
      }
    } else if (t.taxMinor > 0) summaryRows.push({ label: 'Output GST', minor: t.taxMinor });
    if (grand.roundOffMinor !== 0) summaryRows.push({ label: 'Round off', minor: grand.roundOffMinor });
  }
  const units = new Set(quote.items.map((i) => (i.unit ?? '').trim()));
  const totalQty = quote.items.reduce((s, i) => s + Number(i.quantity), 0);
  // Always show the summed quantity; append the unit only when every line shares
  // one real unit (a purely numeric "unit" is a data-entry slip, not a unit).
  const sharedUnit = units.size === 1 ? [...units][0] : '';
  const unitSuffix = sharedUnit && !/^[\d.,\s]+$/.test(sharedUnit) ? ` ${sharedUnit}` : '';
  const qtyText = quote.items.length > 0 ? `${formatQuantity(totalQty)}${unitSuffix}` : '';

  /* ---------- HSN summary ---------- */
  const hsnRows = totals?.settings.showTaxBreakdown ? hsnSummary(quote.items) : [];
  const showHsn = hsnRows.some((r) => r.taxMinor !== 0);
  const hsnTotal = hsnRows.reduce((a, r) => ({ taxable: a.taxable + r.taxableMinor, tax: a.tax + r.taxMinor }), { taxable: 0, tax: 0 });
  const half = (r: { taxMinor: number }) => Math.round(r.taxMinor / 2);
  const cgstTotal = hsnRows.reduce((a, x) => a + half(x), 0);
  const hsnCell = (w: string | number, right = true, last = false) => [{ width: w, paddingHorizontal: 3, paddingVertical: 2 }, ...(last ? [] : [bRight]), ...(right ? [styles.right] : [])];
  const taxCols = interState ? ['Integrated Tax'] : ['Central Tax', 'State Tax'];

  /* ---------- Bank ---------- */
  const bank: [string, string][] = [];
  if (seller.bankName || seller.bankAccount) {
    bank.push(["A/c Holder's Name", seller.name]);
    if (seller.bankName) bank.push(['Bank Name', seller.bankName]);
    if (seller.bankAccount) bank.push(['A/c No.', seller.bankAccount]);
    const br = [seller.bankBranch, seller.bankIfsc].filter(Boolean).join(' & ');
    if (br) bank.push(['Branch & IFSC Code', br]);
  }

  const showWords = totals?.settings.showAmountInWords ?? false;

  return (
    <Document title={ref} author={seller.name} subject={`${title} for ${quote.buyer.name}`} creator="CRM" producer="CRM">
      <Page size={body.theme.pageSize} style={ctx.styles.page} wrap>
        <Text style={{ textAlign: 'center', fontWeight: 700, fontSize: fs * 1.5, color: body.theme.primaryColor, marginBottom: 4 }}>{title}</Text>

        <View style={{ ...B, borderWidth: 0.6 }}>
          {/* ---------- Header grid ---------- */}
          <View style={[{ flexDirection: 'row' }, bBottom]}>
            <View style={[{ width: '55%' }, bRight]}>
              <View style={[{ flexDirection: 'row', padding: 4 }, client ? bBottom : {}]}>
                {logo}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.bold, { fontSize: fs * 1.15 }]}>{seller.name}</Text>
                  {sellerLines.map((l, i) => (
                    <Text key={i} style={small}>
                      {l}
                    </Text>
                  ))}
                </View>
              </View>
              {client?.settings.showShipTo ? (
                <View style={[{ padding: 4 }, bBottom]}>
                  <Text style={[small, { color: '#374151' }]}>{client.settings.shipToLabel}</Text>
                  <Text style={styles.bold}>{(quote.consignee ?? quote.buyer).name}</Text>
                  {partyLines(quote.consignee ?? quote.buyer).map((l, i) => (
                    <Text key={i} style={small}>
                      {l}
                    </Text>
                  ))}
                </View>
              ) : null}
              {client ? (
                <View style={{ padding: 4 }}>
                  <Text style={[small, { color: '#374151' }]}>{client.settings.billToLabel}</Text>
                  <Text style={styles.bold}>{quote.buyer.name}</Text>
                  {partyLines(quote.buyer).map((l, i) => (
                    <Text key={i} style={small}>
                      {l}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>

            <View style={{ flex: 1 }}>
              {metaRows.map((pair, i) => (
                <View key={i} style={[{ flexDirection: 'row' }, bBottom]}>
                  {pair.map((m, j) => (
                    <Cell key={j} label={m.label} value={m.value} fs={fs} last={j === pair.length - 1} />
                  ))}
                </View>
              ))}
              {payment ? (
                <View style={[{ flexDirection: 'row' }, terms ? bBottom : {}]}>
                  <Cell label={payment.title || 'Mode/Terms of Payment'} value={milestonesLine(effectiveMilestones(payment, quote.content))} fs={fs} last />
                </View>
              ) : null}
              {terms ? (
                <View style={{ paddingHorizontal: 3, paddingVertical: 2, flexGrow: 1 }}>
                  <Text style={{ fontSize: fs * 0.85, color: '#374151' }}>{terms.title || 'Terms of Delivery'}</Text>
                  <View style={small}>
                    <RichTextPdf doc={resolvePlaceholders(effectiveSectionTerms(terms, quote.content), ctx.placeholderValues)} styles={{ ...styles, paragraph: { marginBottom: 1 } }} />
                  </View>
                </View>
              ) : null}
            </View>
          </View>

          {/* ---------- Items ---------- */}
          <View style={[{ flexDirection: 'row', backgroundColor: HEAD_BG }, bBottom]} fixed>
            {columns.map((c, i) => (
              <Text key={c.key} style={[...colStyle(c.key, i), styles.bold, { textAlign: c.key === 'description' ? 'left' : 'center' }]}>
                {c.label}
              </Text>
            ))}
          </View>
          {quote.items.length ? (
            quote.items.map((it, i) =>
              tableRow(it.id, Object.fromEntries(columns.map((c) => [c.key, itemCell(c.key, it, i)])) as Partial<Record<ColumnKey, string>>),
            )
          ) : (
            tableRow('empty', { description: 'No items' })
          )}
          {tableRow('gap', {})}
          {summaryRows.map((r, i) => tableRow(`s${i}`, { description: r.label, amount: formatMoney(r.minor) }, { italicLabel: true, top: i === 0 }))}
          {tableRow('grand', { description: 'Grand Total', quantity: qtyText, amount: formatMoney(grand.payableMinor) }, { bold: true, top: true })}

          {/* ---------- Amount in words ---------- */}
          {showWords ? (
            <View style={[{ flexDirection: 'row', justifyContent: 'space-between', padding: 4 }, bTop]} wrap={false}>
              <Text style={{ flex: 1 }}>
                <Text style={small}>Amount Chargeable (in words): </Text>
                <Text style={styles.bold}>{amountInWords(grand.payableMinor, quote.currency)}</Text>
              </Text>
              <Text style={[small, { fontStyle: 'italic' }]}>E. &amp; O.E</Text>
            </View>
          ) : null}

          {/* ---------- HSN-wise tax summary ---------- */}
          {showHsn ? (
            <View style={[bTop, small]} wrap={false}>
              <View style={[{ flexDirection: 'row', backgroundColor: HEAD_BG }, bBottom, styles.bold]}>
                <Text style={[...hsnCell('25%', false), { paddingTop: 6 }]}>HSN/SAC</Text>
                <Text style={[...hsnCell('20%'), { paddingTop: 6 }]}>Taxable Value</Text>
                {taxCols.map((label) => (
                  <View key={label} style={[{ width: interState ? '35%' : '20%' }, bRight]}>
                    <Text style={[{ textAlign: 'center', paddingVertical: 1 }, bBottom]}>{label}</Text>
                    <View style={{ flexDirection: 'row' }}>
                      <Text style={[...hsnCell('40%', false), { textAlign: 'center' }]}>Rate</Text>
                      <Text style={hsnCell('60%', true, true)}>Amount</Text>
                    </View>
                  </View>
                ))}
                <Text style={[...hsnCell(interState ? '20%' : '15%', true, true), { paddingTop: 1 }]}>Total Tax Amount</Text>
              </View>
              {[...hsnRows.map((r) => ({ ...r, total: false })), { hsn: 'Total', rateBps: -1, taxableMinor: hsnTotal.taxable, taxMinor: hsnTotal.tax, total: true }].map((r, i) => {
                const parts = interState ? [r.taxMinor] : [half(r), r.taxMinor - half(r)];
                const rate = r.rateBps < 0 ? '' : formatBps(interState ? r.rateBps : r.rateBps / 2);
                const amounts = r.total ? (interState ? [r.taxMinor] : [cgstTotal, r.taxMinor - cgstTotal]) : parts;
                return (
                  <View key={i} style={r.total ? [{ flexDirection: 'row' }, bTop, styles.bold] : { flexDirection: 'row' }}>
                    <Text style={hsnCell('25%', false)}>{r.hsn}</Text>
                    <Text style={hsnCell('20%')}>{formatMoney(r.taxableMinor)}</Text>
                    {amounts.map((a, j) => (
                      <View key={j} style={[{ width: interState ? '35%' : '20%', flexDirection: 'row' }, bRight]}>
                        <Text style={[...hsnCell('40%', false), { textAlign: 'center' }]}>{rate}</Text>
                        <Text style={hsnCell('60%', true, true)}>{formatMoney(a)}</Text>
                      </View>
                    ))}
                    <Text style={hsnCell(interState ? '20%' : '15%', true, true)}>{formatMoney(r.taxMinor)}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* ---------- Bottom box ---------- */}
          <View style={[{ flexDirection: 'row', minHeight: 90 }, bTop]} wrap={false}>
            <View style={[{ width: '55%', padding: 4 }, bRight]}>
              {showWords && t.taxMinor > 0 ? (
                <Text style={{ marginBottom: 4 }}>
                  <Text style={small}>Tax Amount (in words): </Text>
                  <Text style={styles.bold}>{amountInWords(t.taxMinor, quote.currency)}</Text>
                </Text>
              ) : null}
              {seller.pan ? (
                <Text style={{ marginBottom: 6 }}>
                  <Text style={small}>Company&apos;s PAN : </Text>
                  <Text style={styles.bold}>{seller.pan}</Text>
                </Text>
              ) : null}
              {texts.map((s) => (
                <View key={s.id} style={{ marginBottom: 4 }}>
                  {s.title ? <Text style={[styles.bold, { textDecoration: 'underline' }]}>{s.title}</Text> : null}
                  <View style={small}>
                    <RichTextPdf doc={resolvePlaceholders(effectiveSectionText(s, quote.content), ctx.placeholderValues)} styles={{ ...styles, paragraph: { marginBottom: 2 } }} />
                  </View>
                </View>
              ))}
              {signature?.settings.showClientAcceptance ? (
                <View style={{ marginTop: 'auto', paddingTop: 24 }}>
                  <Text style={small}>Customer&apos;s Seal and Signature</Text>
                </View>
              ) : null}
            </View>
            <View style={{ flex: 1, padding: 4 }}>
              {bank.length ? (
                <View>
                  <Text style={[styles.bold, { marginBottom: 2 }]}>Company&apos;s Bank Details</Text>
                  {bank.map(([k, v]) => (
                    <View key={k} style={{ flexDirection: 'row' }}>
                      <Text style={[small, { width: '42%' }]}>{k}</Text>
                      <Text style={[small, styles.bold, { flex: 1 }]}>: {v}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {signature ? (
                <View style={{ marginTop: 'auto', paddingTop: 8, alignItems: 'flex-end' }}>
                  <Text style={styles.bold}>For {seller.name}</Text>
                  <View style={{ height: 30 }} />
                  <Text>{signature.settings.signatoryName || 'Authorised Signatory'}</Text>
                  {signature.settings.signatoryTitle ? <Text style={small}>{signature.settings.signatoryTitle}</Text> : null}
                </View>
              ) : null}
            </View>
          </View>
        </View>

        <View style={ctx.styles.footer} fixed>
          <Text>{ref}</Text>
          <Text>This is a computer generated document</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
