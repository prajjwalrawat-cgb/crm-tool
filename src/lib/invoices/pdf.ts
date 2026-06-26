import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

import type { InvoicePdfData, PdfParty } from './types';

/**
 * Client-side PDF generation for a Proforma Invoice, laid out to mirror
 * the standard Indian PI format (seller / bill-to / ship-to blocks, line
 * items, GST totals, amount in words, bank + declaration).
 *
 * Note: amounts use "INR" / plain numbers rather than the ₹ glyph — jsPDF's
 * built-in Helvetica can't render the rupee sign.
 */

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
const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty',
  'Ninety',
];

function twoDigit(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${TENS[t]}${o ? ' ' + ONES[o] : ''}`;
}

/** Indian numbering (crore / lakh / thousand / hundred). */
function inWords(num: number): string {
  if (num === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(num / 1e7);
  num %= 1e7;
  const lakh = Math.floor(num / 1e5);
  num %= 1e5;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = Math.floor(num / 100);
  const rest = num % 100;
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
  const cur = currency === 'INR' ? 'INR' : currency;
  let out = `${cur} ${inWords(rupees)}`;
  if (paise) out += ` and ${twoDigit(paise)} Paise`;
  return `${out} Only`;
}

function placeLine(p: PdfParty): string {
  const place = [p.locality, p.city].filter(Boolean).join(', ');
  return [place, p.pincode].filter(Boolean).join(' - ');
}

function partyLines(p: PdfParty): string[] {
  const lines = [p.name];
  if (p.address) lines.push(p.address);
  const place = placeLine(p);
  if (place) lines.push(place);
  if (p.gstin) lines.push(`GSTIN/UIN: ${p.gstin}`);
  if (p.state) lines.push(`State: ${p.state}${p.stateCode ? `, Code: ${p.stateCode}` : ''}`);
  return lines;
}

export function generateInvoicePdf(data: InvoicePdfData): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const margin = 12;
  const right = W - margin;
  let y = 16;

  doc.setFont('helvetica', 'bold').setFontSize(14);
  doc.text('Proforma Invoice', W / 2, y, { align: 'center' });
  y += 7;

  // Seller (left) + PI meta (right)
  doc.setDrawColor(180).setLineWidth(0.2);
  doc.line(margin, y, right, y);
  y += 5;

  const metaX = W / 2 + 6;
  doc.setFont('helvetica', 'bold').setFontSize(10);
  doc.text(data.seller.name, margin, y);
  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  let ly = y + 4;
  const sellerMeta: string[] = [];
  if (data.seller.address) sellerMeta.push(data.seller.address);
  const sellerPlace = placeLine(data.seller);
  if (sellerPlace) sellerMeta.push(sellerPlace);
  if (data.seller.gstin) sellerMeta.push(`GSTIN/UIN: ${data.seller.gstin}`);
  if (data.seller.state)
    sellerMeta.push(`State: ${data.seller.state}${data.seller.stateCode ? `, Code: ${data.seller.stateCode}` : ''}`);
  if (data.seller.cin) sellerMeta.push(`CIN: ${data.seller.cin}`);
  for (const line of sellerMeta) {
    for (const wrapped of doc.splitTextToSize(line, W / 2 - margin - 4) as string[]) {
      doc.text(wrapped, margin, ly);
      ly += 4;
    }
  }

  // PI meta box (right)
  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  doc.text('Proforma Invoice No.', metaX, y);
  doc.setFont('helvetica', 'bold').setFontSize(10);
  doc.text(data.piNumber, metaX, y + 4.5);
  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  doc.text('Dated', metaX + 70, y);
  doc.setFont('helvetica', 'bold').setFontSize(10);
  doc.text(data.piDate, metaX + 70, y + 4.5);
  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  if (data.paymentTerms) {
    doc.text('Mode/Terms of Payment', metaX, y + 11);
    doc.setFont('helvetica', 'bold');
    for (const wrapped of doc.splitTextToSize(data.paymentTerms, right - metaX) as string[]) {
      doc.text(wrapped, metaX, (y += 0) + 15);
      y += 4;
    }
    doc.setFont('helvetica', 'normal');
  }

  y = Math.max(ly, y) + 6;

  // Bill-to / Ship-to
  doc.setLineWidth(0.2);
  doc.line(margin, y, right, y);
  y += 5;
  const colW = (right - margin) / 2;
  doc.setFont('helvetica', 'bold').setFontSize(8.5);
  doc.text('Buyer (Bill to)', margin, y);
  doc.text('Consignee (Ship to)', margin + colW, y);
  doc.setFont('helvetica', 'normal');
  let by = y + 4;
  const buyerLines = partyLines(data.buyer);
  const shipLines = partyLines(data.consignee ?? data.buyer);
  const maxLines = Math.max(buyerLines.length, shipLines.length);
  for (let i = 0; i < maxLines; i++) {
    if (buyerLines[i]) {
      for (const w of doc.splitTextToSize(buyerLines[i]!, colW - 4) as string[]) {
        doc.text(w, margin, by);
        by += 4;
      }
    }
  }
  let sy = y + 4;
  for (let i = 0; i < shipLines.length; i++) {
    for (const w of doc.splitTextToSize(shipLines[i]!, colW - 4) as string[]) {
      doc.text(w, margin + colW, sy);
      sy += 4;
    }
  }
  y = Math.max(by, sy) + 4;

  // Line items
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
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
        { content: 'Subtotal', colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: money(data.subtotalMinor), styles: { halign: 'right' } },
      ],
      [
        { content: `Output GST @ ${Number(data.taxRate)}%`, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: money(data.taxMinor), styles: { halign: 'right' } },
      ],
      [
        { content: `Total (${data.currency})`, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: money(data.totalMinor), styles: { halign: 'right', fontStyle: 'bold' } },
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: [241, 245, 249], textColor: 20, fontSize: 8, fontStyle: 'bold' },
    footStyles: { fillColor: [255, 255, 255], textColor: 20, fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: 30 },
    columnStyles: {
      0: { cellWidth: 9, halign: 'center' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 20 },
      3: { cellWidth: 14, halign: 'right' },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 11, halign: 'center' },
      6: { cellWidth: 28, halign: 'right' },
    },
  });

  // finalY after the table
  const tableEnd = (doc as unknown as { lastAutoTable: { finalY: number } })
    .lastAutoTable.finalY;
  y = tableEnd + 6;

  doc.setFont('helvetica', 'bold').setFontSize(8.5);
  doc.text('Amount Chargeable (in words):', margin, y);
  doc.setFont('helvetica', 'normal');
  for (const w of doc.splitTextToSize(amountInWords(data.totalMinor, data.currency), right - margin - 55) as string[]) {
    doc.text(w, margin + 55, y);
    y += 4;
  }
  y += 4;

  // Bank details + declaration
  const seller = data.seller;
  if (seller.bankName || seller.bankAccount || seller.pan) {
    doc.setFont('helvetica', 'bold').setFontSize(8.5);
    doc.text("Company's Bank Details", margin, y);
    doc.setFont('helvetica', 'normal');
    let bky = y + 4;
    const bank: string[] = [];
    if (seller.pan) bank.push(`PAN: ${seller.pan}`);
    if (seller.bankName) bank.push(`Bank: ${seller.bankName}`);
    if (seller.bankAccount) bank.push(`A/c No.: ${seller.bankAccount}`);
    if (seller.bankBranch || seller.bankIfsc)
      bank.push(`Branch & IFSC: ${[seller.bankBranch, seller.bankIfsc].filter(Boolean).join(' & ')}`);
    for (const line of bank) {
      doc.text(line, margin, bky);
      bky += 4;
    }
    y = bky;
  }

  if (data.notes) {
    y += 2;
    doc.setFont('helvetica', 'bold').setFontSize(8.5);
    doc.text('Notes:', margin, y);
    doc.setFont('helvetica', 'normal');
    y += 4;
    for (const w of doc.splitTextToSize(data.notes, right - margin) as string[]) {
      doc.text(w, margin, y);
      y += 4;
    }
  }

  // Signatory
  y = Math.max(y + 8, doc.internal.pageSize.getHeight() - 30);
  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  doc.text(`For ${seller.name}`, right, y, { align: 'right' });
  doc.text('Authorised Signatory', right, y + 12, { align: 'right' });
  doc.setFontSize(7).setTextColor(120);
  doc.text('This is a Computer Generated Invoice', W / 2, doc.internal.pageSize.getHeight() - 8, { align: 'center' });

  doc.save(`${data.piNumber.replace(/[/\\]/g, '-')}.pdf`);
}
