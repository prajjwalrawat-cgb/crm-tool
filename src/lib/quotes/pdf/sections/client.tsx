import { Text, View } from '@react-pdf/renderer';

import type { QuoteSection } from '../../template-schema';
import type { QuoteParty } from '../../types';
import { partyAddressLines, type QuoteStyles, type RenderContext } from '../context';

type ClientSection = Extract<QuoteSection, { type: 'client' }>;

function PartyBlock({ label, party, styles }: { label: string; party: QuoteParty; styles: QuoteStyles }) {
  return (
    <View style={{ flex: 1, paddingRight: 12 }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <Text style={styles.bold}>{party.name}</Text>
      {party.contactName ? <Text>{party.contactName}</Text> : null}
      {partyAddressLines(party).map((l, i) => (
        <Text key={i} style={styles.muted}>
          {l}
        </Text>
      ))}
      {party.gstin ? <Text style={styles.muted}>GSTIN: {party.gstin}</Text> : null}
      {party.contactEmail ? <Text style={styles.muted}>{party.contactEmail}</Text> : null}
    </View>
  );
}

export function ClientSectionPdf({ section, ctx }: { section: ClientSection; ctx: RenderContext }) {
  const { settings } = section;
  const { quote, styles } = ctx;
  return (
    <View style={[styles.section, { flexDirection: 'row' }]} wrap={false}>
      <PartyBlock label={settings.billToLabel} party={quote.buyer} styles={styles} />
      {settings.showShipTo && quote.consignee ? <PartyBlock label={settings.shipToLabel} party={quote.consignee} styles={styles} /> : null}
    </View>
  );
}
