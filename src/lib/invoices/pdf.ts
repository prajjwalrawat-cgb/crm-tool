import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

import { gstBreakdown, partyStateCode } from './gst';
import { INDIAN_STATES } from './india-geo';
import type { InvoicePdfData, PdfParty, PdfSeller } from './types';

/**
 * Client-side Proforma Invoice PDF laid out to match the standard Indian
 * GST PI format: bordered header (seller / ship-to / bill-to + invoice
 * meta), line-item table with a "per" column, totals, amount in words, a
 * tax summary, bank details, a declaration, and the authorised signatory.
 *
 * Amounts use "INR" / plain numbers — jsPDF's built-in Helvetica can't
 * render the ₹ glyph.
 */

const DECLARATION =
  'We hereby declare that our aggregate turnover in a financial year does not ' +
  'exceed the prescribed limit for mandatory issuance of E-Invoice or we are ' +
  'otherwise exempted from E-Invoicing requirement as per the provisions of ' +
  'GST Law, hence we are not required to issue E-Invoice under the GST law and ' +
  'provisions.';

function money(minor: number): string {
  return (minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigit(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${TENS[t]}${o ? ' ' + ONES[o] : ''}`;
}
function inWords(num: number): string {
  if (num === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(num / 1e7); num %= 1e7;
  const lakh = Math.floor(num / 1e5); num %= 1e5;
  const thousand = Math.floor(num / 1000); num %= 1000;
  const hundred = Math.floor(num / 100); const rest = num % 100;
  if (crore) parts.push(`${inWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigit(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigit(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(twoDigit(rest));
  return parts.join(' ');
}
function amountInWords(totalMinor: number, currency: string): string {
  const rupees = Math.floor(totalMinor / 100);
  const paise = totalMinor % 100;
  let out = `${currency} ${inWords(rupees)}`;
  if (paise) out += ` and ${twoDigit(paise)} Paise`;
  return `${out} Only`;
}

/** GST state code = first 2 chars of GSTIN; maps to the state name. */
function stateFromGstin(gstin?: string): { code: string; name: string } | null {
  if (!gstin || gstin.trim().length < 2) return null;
  const code = gstin.trim().slice(0, 2);
  const found = INDIAN_STATES.find((s) => s.code === code);
  return found ? { code, name: found.name } : null;
}

function partyInfoLines(p: PdfParty): string[] {
  const lines: string[] = [];
  if (p.address) lines.push(...p.address.split(/\r?\n/).filter(Boolean));
  if (p.gstin) lines.push(`GSTIN/UIN : ${p.gstin}`);
  const st = stateFromGstin(p.gstin);
  if (st) lines.push(`State Name : ${st.name}, Code : ${st.code}`);
  return lines;
}
function sellerInfoLines(s: PdfSeller): string[] {
  const lines = partyInfoLines(s);
  if (s.cin) lines.push(`CIN : ${s.cin}`);
  return lines;
}

function formatDate(iso: string): string {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, mo, d] = iso.split('-').map(Number);
  if (!y || !mo || !d) return iso;
  return `${String(d).padStart(2, '0')}-${m[mo - 1]}-${String(y).slice(-2)}`;
}

type LoadedLogo = { dataUrl: string; w: number; h: number };

/**
 * Decode a logo data URL and re-encode it to PNG via a canvas so jsPDF always
 * receives a supported, non-tainted image (the source is a same-origin data
 * URL — no fetch, no CORS). Also yields the natural dimensions for aspect
 * ratio. Returns null on any failure so the PDF still renders without a logo.
 * Browser-only (uses Image / canvas).
 */
async function loadLogo(dataUrl: string): Promise<LoadedLogo | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode failed'));
      i.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return {
      dataUrl: canvas.toDataURL('image/png'),
      w: img.naturalWidth,
      h: img.naturalHeight,
    };
  } catch {
    return null;
  }
}

export async function buildInvoiceDoc(data: InvoicePdfData): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const L = 8;
  const R = W - 8;
  const MID = L + (R - L) * 0.56; // seller/parties column vs meta column
  const cur = data.currency;
  const consignee = data.consignee ?? data.buyer;

  doc.setLineWidth(0.2);
  doc.setDrawColor(60);

  // Title
  doc.setFont('helvetica', 'bold').setFontSize(13);
  doc.text('Proforma Invoice', W / 2, 12, { align: 'center' });

  const headerTop = 15;

  /* ---------- LEFT column (seller / consignee / buyer) ---------- */
  const leftX = L + 2;
  const leftW = MID - L - 4;

  // Optional workspace logo, top-left; the seller text shifts right of it.
  let sellerX = leftX;
  let sellerW = leftW;
  const logo = data.logoDataUrl ? await loadLogo(data.logoDataUrl) : null;
  if (logo && logo.w > 0 && logo.h > 0) {
    const ratio = Math.min(24 / logo.w, 14 / logo.h);
    const dw = logo.w * ratio;
    const dh = logo.h * ratio;
    try {
      doc.addImage(logo.dataUrl, 'PNG', leftX, headerTop + 3.5, dw, dh);
      sellerX = leftX + dw + 3;
      sellerW = MID - sellerX - 2;
    } catch {
      // ignore — fall back to no logo
    }
  }

  // Seller
  let ly = headerTop + 5;
  doc.setFont('helvetica', 'bold').setFontSize(9.5);
  for (const w of doc.splitTextToSize(data.seller.name, sellerW) as string[]) {
    doc.text(w, sellerX, ly); ly += 4;
  }
  doc.setFont('helvetica', 'normal').setFontSize(8);
  for (const line of sellerInfoLines(data.seller)) {
    for (const w of doc.splitTextToSize(line, sellerW) as string[]) { doc.text(w, sellerX, ly); ly += 3.6; }
  }
  const div1 = ly + 1.5;

  // Consignee (Ship to)
  doc.setFont('helvetica', 'bold').setFontSize(7.5);
  doc.text('Consignee (Ship to)', leftX, div1 + 4);
  let cy = div1 + 8;
  doc.setFont('helvetica', 'bold').setFontSize(8.5);
  for (const w of doc.splitTextToSize(consignee.name, leftW) as string[]) { doc.text(w, leftX, cy); cy += 4; }
  doc.setFont('helvetica', 'normal').setFontSize(8);
  for (const line of partyInfoLines(consignee)) {
    for (const w of doc.splitTextToSize(line, leftW) as string[]) { doc.text(w, leftX, cy); cy += 3.6; }
  }
  const div2 = cy + 1.5;

  // Buyer (Bill to)
  doc.setFont('helvetica', 'bold').setFontSize(7.5);
  doc.text('Buyer (Bill to)', leftX, div2 + 4);
  let by = div2 + 8;
  doc.setFont('helvetica', 'bold').setFontSize(8.5);
  for (const w of doc.splitTextToSize(data.buyer.name, leftW) as string[]) { doc.text(w, leftX, by); by += 4; }
  doc.setFont('helvetica', 'normal').setFontSize(8);
  for (const line of partyInfoLines(data.buyer)) {
    for (const w of doc.splitTextToSize(line, leftW) as string[]) { doc.text(w, leftX, by); by += 3.6; }
  }

  /* ---------- RIGHT column (invoice meta) ---------- */
  const rx = MID + 2;
  const rw = R - MID - 4;
  doc.setFont('helvetica', 'normal').setFontSize(7.5);
  doc.text('Proforma Invoice No.', rx, headerTop + 4);
  doc.text('Dated', rx + rw / 2, headerTop + 4);
  doc.setFont('helvetica', 'bold').setFontSize(9);
  doc.text(data.piNumber, rx, headerTop + 8.5);
  doc.text(formatDate(data.piDate), rx + rw / 2, headerTop + 8.5);

  const rMetaDiv1 = headerTop + 11;
  doc.line(MID, rMetaDiv1, R, rMetaDiv1);

  doc.setFont('helvetica', 'normal').setFontSize(7.5);
  doc.text('Mode/Terms of Payment', rx, rMetaDiv1 + 4);
  doc.setFont('helvetica', 'bold').setFontSize(8);
  let py = rMetaDiv1 + 8;
  if (data.paymentTerms) {
    for (const w of doc.splitTextToSize(data.paymentTerms, rw) as string[]) { doc.text(w, rx, py); py += 3.6; }
  }
  const rMetaDiv2 = Math.max(py + 1, rMetaDiv1 + 12);
  doc.line(MID, rMetaDiv2, R, rMetaDiv2);

  doc.setFont('helvetica', 'normal').setFontSize(7.5);
  doc.text('Terms of Delivery', rx, rMetaDiv2 + 4);
  doc.setFont('helvetica', 'bold').setFontSize(8);
  let dy = rMetaDiv2 + 8;
  if (data.deliveryTerms) {
    for (const w of doc.splitTextToSize(data.deliveryTerms, rw) as string[]) { doc.text(w, rx, dy); dy += 3.6; }
  }

  const headerBottom = Math.max(by, dy) + 2;

  /* ---------- Header borders ---------- */
  doc.line(L, headerTop, R, headerTop); // top
  doc.line(L, headerTop, L, headerBottom); // left
  doc.line(R, headerTop, R, headerBottom); // right
  doc.line(MID, headerTop, MID, headerBottom); // column divider
  doc.line(L, div1, MID, div1); // seller/consignee
  doc.line(L, div2, MID, div2); // consignee/buyer
  doc.line(L, headerBottom, R, headerBottom); // bottom

  /* ---------- Line items ---------- */
  const totalQty = data.items.reduce((s, it) => s + it.quantity, 0);
  const unit = data.items[0]?.unit || 'No';

  autoTable(doc, {
    startY: headerBottom,
    margin: { left: L, right: L },
    head: [['Sl', 'Description of Goods/Services', 'HSN/SAC', 'Qty', 'Rate', 'per', 'Amount']],
    body: data.items.map((it, i) => [
      String(i + 1),
      it.description,
      it.hsnSac ?? '',
      String(it.quantity),
      money(it.rateMinor),
      it.unit,
      money(it.amountMinor),
    ]),
    foot: [
      [
        { content: 'Total', colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: money(data.subtotalMinor), styles: { halign: 'right' } },
      ],
      [
        { content: `Output GST @ ${Number(data.taxRate)}%`, colSpan: 6, styles: { halign: 'right' } },
        { content: money(data.taxMinor), styles: { halign: 'right' } },
      ],
      [
        { content: 'Total', colSpan: 3, styles: { fontStyle: 'bold' } },
        { content: `${totalQty} ${unit}`, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: '' },
        { content: '' },
        { content: money(data.totalMinor), styles: { halign: 'right', fontStyle: 'bold' } },
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: [240, 240, 240], textColor: 20, fontSize: 8, fontStyle: 'bold', lineWidth: 0.2, lineColor: [60, 60, 60] },
    footStyles: { fillColor: [255, 255, 255], textColor: 20, fontSize: 8, lineWidth: 0.2, lineColor: [60, 60, 60] },
    bodyStyles: { fontSize: 8, textColor: 30, lineWidth: 0.2, lineColor: [60, 60, 60], minCellHeight: 6 },
    columnStyles: {
      0: { cellWidth: 9, halign: 'center' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 20 },
      3: { cellWidth: 14, halign: 'right' },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 11, halign: 'center' },
      6: { cellWidth: 26, halign: 'right' },
    },
  });

  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  /* ---------- Amount in words ---------- */
  doc.rect(L, y, R - L, 6.5);
  doc.setFont('helvetica', 'normal').setFontSize(8);
  doc.text('Amount Chargeable (in words):', L + 2, y + 4.3);
  doc.setFont('helvetica', 'bold');
  doc.text(amountInWords(data.totalMinor, cur), L + 52, y + 4.3);
  y += 6.5;

  /* ---------- Tax summary (IGST vs CGST + SGST) ---------- */
  const hsnLabel =
    data.items.map((i) => i.hsnSac).filter(Boolean).join(', ') || '';
  // Place of supply = ship-to (consignee) state, then bill-to (buyer).
  const gst = gstBreakdown({
    sellerStateCode: partyStateCode(data.seller),
    placeStateCode:
      partyStateCode(data.consignee) ?? partyStateCode(data.buyer),
    taxRate: Number(data.taxRate),
    taxMinor: data.taxMinor,
  });
  const taxStyles = {
    theme: 'grid' as const,
    styles: { fontSize: 7.5, textColor: 25, lineWidth: 0.2, lineColor: [60, 60, 60] as [number, number, number] },
    headStyles: { fillColor: [240, 240, 240] as [number, number, number], textColor: 20, fontSize: 7, fontStyle: 'bold' as const },
    footStyles: { fillColor: [255, 255, 255] as [number, number, number], textColor: 20, fontSize: 7.5 },
  };

  if (gst.interState) {
    autoTable(doc, {
      startY: y,
      margin: { left: L, right: L },
      head: [
        [
          { content: 'HSN/SAC', rowSpan: 2, styles: { valign: 'middle' } },
          { content: 'Taxable Value', rowSpan: 2, styles: { valign: 'middle', halign: 'right' } },
          { content: 'Integrated Tax (IGST)', colSpan: 2, styles: { halign: 'center' } },
          { content: 'Total Tax Amount', rowSpan: 2, styles: { valign: 'middle', halign: 'right' } },
        ],
        ['Rate', 'Amount'],
      ],
      body: [[
        hsnLabel,
        money(data.subtotalMinor),
        `${gst.igstRate}%`,
        money(gst.igstMinor),
        money(data.taxMinor),
      ]],
      foot: [[
        { content: 'Total', styles: { fontStyle: 'bold' } },
        { content: money(data.subtotalMinor), styles: { halign: 'right' } },
        { content: '' },
        { content: money(gst.igstMinor), styles: { halign: 'right' } },
        { content: money(data.taxMinor), styles: { halign: 'right', fontStyle: 'bold' } },
      ]],
      ...taxStyles,
      columnStyles: {
        1: { halign: 'right' }, 2: { halign: 'center' }, 3: { halign: 'right' }, 4: { halign: 'right' },
      },
    });
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: L, right: L },
      head: [
        [
          { content: 'HSN/SAC', rowSpan: 2, styles: { valign: 'middle' } },
          { content: 'Taxable Value', rowSpan: 2, styles: { valign: 'middle', halign: 'right' } },
          { content: 'Central Tax', colSpan: 2, styles: { halign: 'center' } },
          { content: 'State Tax', colSpan: 2, styles: { halign: 'center' } },
          { content: 'Total Tax Amount', rowSpan: 2, styles: { valign: 'middle', halign: 'right' } },
        ],
        ['Rate', 'Amount', 'Rate', 'Amount'],
      ],
      body: [[
        hsnLabel,
        money(data.subtotalMinor),
        `${gst.halfRate}%`,
        money(gst.cgstMinor),
        `${gst.halfRate}%`,
        money(gst.sgstMinor),
        money(data.taxMinor),
      ]],
      foot: [[
        { content: 'Total', styles: { fontStyle: 'bold' } },
        { content: money(data.subtotalMinor), styles: { halign: 'right' } },
        { content: '' },
        { content: money(gst.cgstMinor), styles: { halign: 'right' } },
        { content: '' },
        { content: money(gst.sgstMinor), styles: { halign: 'right' } },
        { content: money(data.taxMinor), styles: { halign: 'right', fontStyle: 'bold' } },
      ]],
      ...taxStyles,
      columnStyles: {
        1: { halign: 'right' }, 2: { halign: 'center' }, 3: { halign: 'right' },
        4: { halign: 'center' }, 5: { halign: 'right' }, 6: { halign: 'right' },
      },
    });
  }
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  /* ---------- Bottom box: [tax-in-words + PAN + declaration] | [bank details + signatory] ---------- */
  const s = data.seller;
  const boxTop = y;
  const splitX = L + (R - L) * 0.52; // left content | bank/signatory column

  // LEFT column: tax amount in words, PAN, declaration
  const lx = L + 2;
  const lw = splitX - lx - 3;
  let ly2 = boxTop + 4.5;
  doc.setFont('helvetica', 'normal').setFontSize(8);
  for (const w of doc.splitTextToSize(`Tax Amount (in words): ${amountInWords(data.taxMinor, cur)}`, lw) as string[]) {
    doc.text(w, lx, ly2); ly2 += 4;
  }
  ly2 += 1.5;
  if (s.pan) {
    doc.setFont('helvetica', 'bold').setFontSize(8);
    const label = "Company's PAN : ";
    doc.text(label, lx, ly2);
    doc.setFont('helvetica', 'normal');
    doc.text(s.pan, lx + doc.getTextWidth(label), ly2);
    ly2 += 10.5;
  }
  doc.setFont('helvetica', 'bold').setFontSize(8);
  doc.text('Declaration', lx, ly2);
  ly2 += 4;
  doc.setFont('helvetica', 'normal').setFontSize(7.5);
  for (const w of doc.splitTextToSize(DECLARATION, lw) as string[]) {
    doc.text(w, lx, ly2); ly2 += 3.4;
  }
  const leftBottom = ly2 + 2;

  // RIGHT column: bank details (top), authorised signatory (bottom)
  const bx = splitX + 3;
  const bw = R - bx - 2;
  let ry = boxTop + 4.5;
  doc.setFont('helvetica', 'bold').setFontSize(8.5);
  doc.text("Company's Bank Details", bx, ry);
  ry += 4.4;
  doc.setFont('helvetica', 'normal').setFontSize(8);
  const bank: string[] = [`A/c Holder's Name : ${s.name}`];
  if (s.bankName) bank.push(`Bank Name : ${s.bankName}`);
  if (s.bankAccount) bank.push(`A/c No. : ${s.bankAccount}`);
  if (s.bankBranch || s.bankIfsc) {
    bank.push(`Branch & IFSC Code : ${[s.bankBranch, s.bankIfsc].filter(Boolean).join(' & ')}`);
  }
  for (const line of bank) {
    for (const w of doc.splitTextToSize(line, bw) as string[]) { doc.text(w, bx + 1, ry); ry += 4; }
  }
  const bankBottom = ry;

  const boxBottom = Math.max(leftBottom, bankBottom + 16, boxTop + 34);

  // Borders + vertical divider
  doc.rect(L, boxTop, R - L, boxBottom - boxTop);
  doc.line(splitX, boxTop, splitX, boxBottom);

  // Signatory, bottom of the right column
  doc.setFont('helvetica', 'normal').setFontSize(8);
  let fy = boxBottom - 11;
  for (const w of doc.splitTextToSize(`For ${s.name}`, bw) as string[]) {
    doc.text(w, R - 2, fy, { align: 'right' }); fy += 4;
  }
  doc.text('Authorised Signatory', R - 2, boxBottom - 3, { align: 'right' });

  doc.setFontSize(7).setTextColor(120);
  doc.text('This is a Computer Generated Invoice', W / 2, H - 8, { align: 'center' });

  return doc;
}

export async function generateInvoicePdf(data: InvoicePdfData): Promise<void> {
  const doc = await buildInvoiceDoc(data);
  doc.save(`${data.piNumber.replace(/[/\\]/g, '-')}.pdf`);
}
