import { View } from '@react-pdf/renderer';

import { resolvePlaceholders, type QuoteSection } from '../../template-schema';
import type { RenderContext } from '../context';
import { RichTextPdf } from '../rich-text-pdf';

type TextSection = Extract<QuoteSection, { type: 'text' }>;

/** Free text block. The section title is the builder's label and is not printed; headings belong in the text. */
export function TextSectionPdf({ section, ctx }: { section: TextSection; ctx: RenderContext }) {
  const doc = ctx.quote.content[section.id]?.text ?? section.settings.defaultText;
  return (
    <View style={ctx.styles.section}>
      <RichTextPdf doc={resolvePlaceholders(doc, ctx.placeholderValues)} styles={ctx.styles} />
    </View>
  );
}
