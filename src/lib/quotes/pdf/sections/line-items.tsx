import { Text, View } from '@react-pdf/renderer';

import type { QuoteSection } from '../../template-schema';
import type { QuoteDetailItem } from '../../types';
import { formatBps, formatMoney, formatQuantity, type RenderContext } from '../context';

type LineItemsSection = Extract<QuoteSection, { type: 'line_items' }>;
type ColumnKey = LineItemsSection['settings']['columns'][number]['key'];

/** Fixed widths; description takes the rest. */
const WIDTH: Record<Exclude<ColumnKey, 'description'>, string> = {
  sno: '6%',
  hsn_sac: '11%',
  unit: '8%',
  quantity: '8%',
  rate: '13%',
  discount: '8%',
  tax_rate: '8%',
  amount: '15%',
};
const RIGHT = new Set<ColumnKey>(['quantity', 'rate', 'discount', 'tax_rate', 'amount']);

function cellText(key: ColumnKey, item: QuoteDetailItem, index: number): string {
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

export function LineItemsSectionPdf({ section, ctx }: { section: LineItemsSection; ctx: RenderContext }) {
  const { styles, quote } = ctx;
  const columns = section.settings.columns.filter((c) => c.visible);
  const cellStyle = (key: ColumnKey) => [
    styles.cell,
    key === 'description' ? { flex: 1 } : { width: WIDTH[key] },
    ...(RIGHT.has(key) ? [styles.right] : []),
  ];

  const rows: React.ReactNode[] = [];
  let lastGroup: string | null = null;
  quote.items.forEach((item, i) => {
    const group = item.groupLabel?.trim() || null;
    if (section.settings.groupByLabel && group && group !== lastGroup) {
      rows.push(
        <View key={`g${i}`} style={[styles.tableRow, { backgroundColor: '#f3f4f6' }]} wrap={false} minPresenceAhead={20}>
          <Text style={[styles.cell, styles.bold, { flex: 1 }]}>{group}</Text>
        </View>,
      );
    }
    lastGroup = group;
    rows.push(
      <View key={item.id} style={styles.tableRow} wrap={false}>
        {columns.map((c) => (
          <Text key={c.key} style={cellStyle(c.key)}>
            {cellText(c.key, item, i)}
          </Text>
        ))}
      </View>,
    );
  });

  return (
    <View style={styles.section}>
      <View style={styles.tableHeader} fixed>
        {columns.map((c) => (
          <Text key={c.key} style={cellStyle(c.key)}>
            {c.label}
          </Text>
        ))}
      </View>
      {rows.length ? (
        rows
      ) : (
        <View style={styles.tableRow}>
          <Text style={[styles.cell, styles.muted, { flex: 1 }]}>No items</Text>
        </View>
      )}
    </View>
  );
}
