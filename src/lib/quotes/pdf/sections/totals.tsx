import { Text, View } from '@react-pdf/renderer';

import { gstBreakdown } from '@/lib/invoices/gst';

import type { QuoteSection } from '../../template-schema';
import { amountInWords } from '../amount-in-words';
import { formatBps, formatMoney, grandTotalForDisplay, supplyStateCodes, type RenderContext } from '../context';

type TotalsSection = Extract<QuoteSection, { type: 'totals' }>;
type Row = { label: string; minor: number; strong?: boolean };

export function TotalsSectionPdf({ section, ctx }: { section: TotalsSection; ctx: RenderContext }) {
  const { settings } = section;
  const { quote, styles } = ctx;
  const t = quote.totals;
  const rows: Row[] = [];

  // Discounts hidden: the subtotal printed is the taxable value (after
  // discounts), so Subtotal + GST still adds up to the Total.
  const hidden = settings.discountDisplay === 'hidden';
  if (settings.showSubtotal) rows.push({ label: 'Subtotal', minor: hidden ? t.taxableMinor : t.subtotalMinor });
  if (settings.discountDisplay === 'combined' && t.discountMinor > 0) {
    rows.push({ label: 'Discount', minor: -t.discountMinor });
  } else if (settings.discountDisplay === 'split') {
    if (t.lineDiscountMinor > 0) rows.push({ label: 'Line discounts', minor: -t.lineDiscountMinor });
    if (t.overallDiscountMinor > 0) rows.push({ label: 'Overall discount', minor: -t.overallDiscountMinor });
  }
  if (!hidden && t.discountMinor > 0) rows.push({ label: 'Taxable value', minor: t.taxableMinor });

  if (settings.showTaxBreakdown) {
    const states = supplyStateCodes(quote);
    for (const g of t.taxGroups) {
      if (g.rateBps === 0) continue;
      const b = gstBreakdown({ sellerStateCode: states.seller, placeStateCode: states.place, taxRate: g.rateBps / 100, taxMinor: g.taxMinor });
      if (b.interState) {
        rows.push({ label: `IGST @ ${formatBps(g.rateBps)}`, minor: b.igstMinor });
      } else {
        rows.push({ label: `CGST @ ${formatBps(g.rateBps / 2)}`, minor: b.cgstMinor });
        rows.push({ label: `SGST @ ${formatBps(g.rateBps / 2)}`, minor: b.sgstMinor });
      }
    }
  } else if (t.taxMinor > 0) {
    rows.push({ label: 'GST', minor: t.taxMinor });
  }

  // Round-off is display only: the stored total stays exact to the paisa.
  const grand = grandTotalForDisplay(ctx);
  if (grand.roundOffMinor !== 0) rows.push({ label: 'Round off', minor: grand.roundOffMinor });
  rows.push({ label: 'Total', minor: grand.payableMinor, strong: true });

  return (
    <View style={styles.section} wrap={false}>
      <View style={{ alignSelf: 'flex-end', width: '50%' }}>
        {rows.map((r, i) => (
          <View
            key={i}
            style={[{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }, ...(r.strong ? [styles.accentRule, { marginTop: 3, paddingTop: 4 }] : [])]}
          >
            <Text style={r.strong ? styles.bold : styles.muted}>{r.label}</Text>
            <Text style={r.strong ? [styles.bold, { fontSize: styles.page.fontSize * 1.15 }] : {}}>{formatMoney(r.minor)}</Text>
          </View>
        ))}
      </View>
      {settings.showAmountInWords ? (
        <Text style={{ marginTop: 6 }}>
          <Text style={styles.muted}>Amount in words: </Text>
          {amountInWords(grand.payableMinor, quote.currency)}
        </Text>
      ) : null}
    </View>
  );
}
