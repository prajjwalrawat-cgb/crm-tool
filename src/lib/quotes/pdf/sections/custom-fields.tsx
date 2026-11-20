import { Text, View } from '@react-pdf/renderer';

import type { QuoteSection } from '../../template-schema';
import type { RenderContext } from '../context';

type CustomFieldsSection = Extract<QuoteSection, { type: 'custom_fields' }>;

function display(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.trim() || '—';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.map(display).join(', ') : '—';
  return JSON.stringify(v);
}

export function CustomFieldsSectionPdf({ section, ctx }: { section: CustomFieldsSection; ctx: RenderContext }) {
  const { styles } = ctx;
  const fields = section.settings.fields;
  if (!fields.length) return null;
  return (
    <View style={styles.section} wrap={false}>
      {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
      {fields.map((f) => (
        <View key={f.key} style={{ flexDirection: 'row', marginBottom: 2 }}>
          <Text style={[styles.muted, { width: '35%', paddingRight: 8 }]}>{f.label || f.key}</Text>
          <Text style={{ flex: 1 }}>{display(Object.hasOwn(ctx.dealCustomFields, f.key) ? ctx.dealCustomFields[f.key] : undefined)}</Text>
        </View>
      ))}
    </View>
  );
}
