/**
 * Renders the restricted TipTap JSON (rich-text.ts) with react-pdf.
 * Placeholders must already be resolved (resolvePlaceholders); any left
 * over are dropped. Unknown node types are ignored.
 */
import { Text, View } from '@react-pdf/renderer';

import type { RichTextBlock, RichTextDoc, RichTextInline } from '../rich-text';
import type { QuoteStyles } from './context';

function Inlines({ nodes }: { nodes: RichTextInline[] | undefined }) {
  return (
    <>
      {(nodes ?? []).map((n, i) => {
        if (n.type === 'hardBreak') return '\n';
        if (n.type !== 'text') return null;
        const bold = n.marks?.some((m) => m.type === 'bold');
        const italic = n.marks?.some((m) => m.type === 'italic');
        if (!bold && !italic) return n.text;
        return (
          <Text key={i} style={{ ...(bold ? { fontWeight: 700 } : {}), ...(italic ? { fontStyle: 'italic' } : {}) }}>
            {n.text}
          </Text>
        );
      })}
    </>
  );
}

function Blocks({ blocks, styles }: { blocks: RichTextBlock[]; styles: QuoteStyles }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'paragraph') {
          return (
            <Text key={i} style={styles.paragraph}>
              {b.content?.length ? <Inlines nodes={b.content} /> : ' '}
            </Text>
          );
        }
        if (b.type === 'heading') {
          return (
            <Text key={i} style={b.attrs.level === 2 ? styles.h2 : styles.h3}>
              <Inlines nodes={b.content} />
            </Text>
          );
        }
        if (b.type === 'bulletList' || b.type === 'orderedList') {
          const start = b.type === 'orderedList' ? (b.attrs?.start ?? 1) : 1;
          return (
            <View key={i} style={styles.paragraph}>
              {b.content.map((item, j) => (
                <View key={j} style={{ flexDirection: 'row' }} wrap={false}>
                  <Text style={{ width: 16 }}>{b.type === 'bulletList' ? '•' : `${start + j}.`}</Text>
                  <View style={{ flex: 1 }}>
                    <Blocks blocks={item.content} styles={styles} />
                  </View>
                </View>
              ))}
            </View>
          );
        }
        return null;
      })}
    </>
  );
}

export function RichTextPdf({ doc, styles }: { doc: RichTextDoc; styles: QuoteStyles }) {
  return (
    <View>
      <Blocks blocks={doc.content} styles={styles} />
    </View>
  );
}
