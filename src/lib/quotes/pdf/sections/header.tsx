import { Image, Text, View } from '@react-pdf/renderer';

import type { QuoteSection } from '../../template-schema';
import { formatDate, MM, partyAddressLines, type RenderContext } from '../context';

type HeaderSection = Extract<QuoteSection, { type: 'header' }>;

export function HeaderSectionPdf({ section, ctx }: { section: HeaderSection; ctx: RenderContext }) {
  const { settings } = section;
  const { quote, styles } = ctx;
  const seller = quote.seller;

  const sellerLines: string[] = [];
  for (const f of settings.showSellerFields) {
    if (f === 'address') sellerLines.push(...partyAddressLines(seller));
    else if (f === 'gstin' && seller.gstin) sellerLines.push(`GSTIN: ${seller.gstin}`);
    else if (f === 'pan' && seller.pan) sellerLines.push(`PAN: ${seller.pan}`);
    // 'email' / 'phone': the seller snapshot (PdfSeller) carries neither yet.
  }

  const meta: [string, string][] = [];
  for (const f of settings.metaFields) {
    if (f === 'number') meta.push(['Quote No.', quote.revision > 1 ? `${quote.quoteNumber} (Rev ${quote.revision})` : quote.quoteNumber]);
    else if (f === 'date') meta.push(['Date', formatDate(quote.quoteDate)]);
    else if (f === 'valid_until') meta.push(['Valid until', formatDate(quote.validUntil)]);
    else if (f === 'rep' && ctx.placeholderValues['rep.name']) meta.push(['Prepared by', ctx.placeholderValues['rep.name']]);
  }

  const logo = ctx.logoUrl ? (
    // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
    <Image src={ctx.logoUrl} style={{ height: settings.logoHeightMm * MM, objectFit: 'contain', maxWidth: 180, marginBottom: 6 }} />
  ) : null;
  const align = settings.logoPosition === 'center' ? 'center' : settings.logoPosition === 'right' ? 'flex-end' : 'flex-start';

  return (
    <View style={styles.section}>
      {logo ? <View style={{ flexDirection: 'row', justifyContent: align }}>{logo}</View> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={[styles.bold, { fontSize: styles.page.fontSize * 1.25 }]}>{seller.name}</Text>
          {sellerLines.map((l, i) => (
            <Text key={i} style={styles.muted}>
              {l}
            </Text>
          ))}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {settings.titleText ? <Text style={styles.title}>{settings.titleText}</Text> : null}
          {meta.map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', marginTop: 2 }}>
              <Text style={[styles.muted, { marginRight: 6 }]}>{k}</Text>
              <Text style={styles.bold}>{v}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={[styles.accentRule, { marginTop: 8 }]} />
    </View>
  );
}
