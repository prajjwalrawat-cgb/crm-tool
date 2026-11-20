import { Text, View } from '@react-pdf/renderer';

import { effectiveSectionTerms, resolvePlaceholders, type QuoteSection } from '../../template-schema';
import type { RenderContext } from '../context';
import { RichTextPdf } from '../rich-text-pdf';

type TermsSection = Extract<QuoteSection, { type: 'terms' }>;

export function TermsSectionPdf({ section, ctx }: { section: TermsSection; ctx: RenderContext }) {
  const doc = effectiveSectionTerms(section, ctx.quote.content);
  return (
    <View style={ctx.styles.section}>
      {section.title ? (
        <Text style={ctx.styles.sectionTitle} minPresenceAhead={40}>
          {section.title}
        </Text>
      ) : null}
      <RichTextPdf doc={resolvePlaceholders(doc, ctx.placeholderValues)} styles={ctx.styles} />
    </View>
  );
}
