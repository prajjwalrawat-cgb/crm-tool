import { Text, View } from '@react-pdf/renderer';

import type { QuoteSection } from '../../template-schema';
import type { RenderContext } from '../context';

type SignatureSection = Extract<QuoteSection, { type: 'signature' }>;

function SignLine() {
  return <View style={{ borderBottomWidth: 0.75, borderBottomColor: '#9ca3af', height: 36, marginBottom: 4 }} />;
}

export function SignatureSectionPdf({ section, ctx }: { section: SignatureSection; ctx: RenderContext }) {
  const { settings } = section;
  const { styles, quote } = ctx;
  return (
    <View style={[styles.section, { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }]} wrap={false}>
      {settings.showClientAcceptance ? (
        <View style={{ width: '45%' }}>
          <Text style={styles.label}>Accepted by</Text>
          <Text style={styles.bold}>{quote.buyer.name}</Text>
          <SignLine />
          <Text style={styles.muted}>Signature, name and date</Text>
        </View>
      ) : (
        <View />
      )}
      <View style={{ width: '45%' }}>
        <Text style={styles.label}>For</Text>
        <Text style={styles.bold}>{quote.seller.name}</Text>
        <SignLine />
        <Text>{settings.signatoryName || 'Authorised signatory'}</Text>
        {settings.signatoryTitle ? <Text style={styles.muted}>{settings.signatoryTitle}</Text> : null}
      </View>
    </View>
  );
}
