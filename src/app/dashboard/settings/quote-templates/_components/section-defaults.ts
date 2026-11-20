/**
 * Section labels and factories for the template builder. Pure.
 */
import { defaultTemplateBody } from '@/lib/quotes/default-template';
import type { QuoteSection } from '@/lib/quotes/template-schema';

export type SectionType = QuoteSection['type'];

export const SECTION_LABELS: Record<SectionType, string> = {
  header: 'Header',
  client: 'Client',
  text: 'Text block',
  line_items: 'Line items',
  totals: 'Totals',
  payment_schedule: 'Payment schedule',
  terms: 'Terms',
  custom_fields: 'Deal fields',
  signature: 'Signature',
  page_break: 'Page break',
};

/** Exactly one of each, always enabled: no add, delete or disable controls. */
export const isLockedSection = (type: SectionType) => type === 'line_items' || type === 'totals';

export const ADDABLE_TYPES: readonly SectionType[] = [
  'text',
  'terms',
  'payment_schedule',
  'custom_fields',
  'signature',
  'header',
  'client',
  'page_break',
];

function uniqueId(type: SectionType, taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
}

/** A new section of `type` with the starter template's settings (or empty ones). */
export function newSection(type: SectionType, takenIds: ReadonlySet<string>): QuoteSection {
  const id = uniqueId(type, takenIds);
  if (type === 'custom_fields') return { id, type, enabled: true, title: 'Details', settings: { fields: [] } };
  if (type === 'page_break') return { id, type, enabled: true, title: 'Page break', settings: {} };
  if (type === 'text') {
    return {
      id,
      type,
      enabled: true,
      title: 'Text',
      settings: { repEditable: true, defaultText: { type: 'doc', content: [{ type: 'paragraph' }] } },
    };
  }
  const starter = defaultTemplateBody().sections.find((s) => s.type === type);
  if (!starter) throw new Error(`No starter settings for section type ${type}`);
  return { ...starter, id, enabled: true };
}
