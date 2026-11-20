import { Text, View } from '@react-pdf/renderer';

import type { QuoteSection } from '../../template-schema';
import { formatBps, formatMoney, type RenderContext } from '../context';

type PaymentScheduleSection = Extract<QuoteSection, { type: 'payment_schedule' }>;

/** Floor each share; the last milestone takes the remainder so the amounts sum to the total. */
function milestoneAmounts(totalMinor: number, shares: { percentBps: number }[]): number[] {
  const amounts = shares.map((m) => Number((BigInt(totalMinor) * BigInt(m.percentBps)) / BigInt(10_000)));
  if (amounts.length) amounts[amounts.length - 1] = totalMinor - amounts.slice(0, -1).reduce((a, b) => a + b, 0);
  return amounts;
}

export function PaymentScheduleSectionPdf({ section, ctx }: { section: PaymentScheduleSection; ctx: RenderContext }) {
  const { styles, quote } = ctx;
  const milestones = quote.content[section.id]?.milestones ?? section.settings.defaultMilestones;
  const amounts = milestoneAmounts(quote.totals.totalMinor, milestones);

  return (
    <View style={styles.section} wrap={false}>
      {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
      <View style={styles.tableHeader}>
        <Text style={[styles.cell, { flex: 1 }]}>Milestone</Text>
        <Text style={[styles.cell, styles.right, { width: '15%' }]}>Share</Text>
        <Text style={[styles.cell, styles.right, { width: '25%' }]}>Amount</Text>
      </View>
      {milestones.map((m, i) => (
        <View key={i} style={styles.tableRow}>
          <Text style={[styles.cell, { flex: 1 }]}>{m.label}</Text>
          <Text style={[styles.cell, styles.right, { width: '15%' }]}>{formatBps(m.percentBps)}</Text>
          <Text style={[styles.cell, styles.right, { width: '25%' }]}>{formatMoney(amounts[i])}</Text>
        </View>
      ))}
    </View>
  );
}
