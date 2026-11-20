/**
 * Quote template schema, placeholders and per-quote content helpers.
 * Pure (zod only): safe on server and client.
 */
import { z } from 'zod';
import { richTextDocSchema, type RichTextBlock, type RichTextDoc, type RichTextInline } from './rich-text';

export const SECTION_TYPES = ['header', 'client', 'text', 'line_items', 'totals', 'payment_schedule', 'terms', 'custom_fields', 'signature', 'page_break'] as const;
export const PLACEHOLDERS = ['client.name', 'client.contact', 'client.gstin', 'deal.name', 'rep.name', 'rep.email', 'quote.number', 'quote.date', 'quote.valid_until', 'seller.name'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

export const quoteThemeSchema = z.object({
  fontFamily: z.enum(['noto-sans', 'inter', 'roboto']),
  primaryColor: hexColor,
  accentColor: hexColor,
  baseFontSize: z.number().min(8).max(12),
  pageSize: z.enum(['A4', 'LETTER']),
  marginsMm: z.number().min(10).max(30),
  logoSource: z.enum(['org', 'invoice', 'none']),
});

const milestoneSchema = z.object({ label: z.string().min(1), percentBps: z.number().int().min(0).max(10_000) });

const LINE_ITEM_COLUMN_KEYS = ['sno', 'description', 'hsn_sac', 'unit', 'quantity', 'rate', 'discount', 'tax_rate', 'amount'] as const;
const columnsSchema = z
  .array(z.object({ key: z.enum(LINE_ITEM_COLUMN_KEYS), label: z.string(), visible: z.boolean() }))
  .superRefine((cols, ctx) => {
    if (new Set(cols.map((c) => c.key)).size !== cols.length) {
      ctx.addIssue({ code: 'custom', message: 'Line item columns must be unique' });
    }
    for (const key of ['description', 'amount'] as const) {
      const col = cols.find((c) => c.key === key);
      if (!col || !col.visible) ctx.addIssue({ code: 'custom', message: `Line item column "${key}" must stay visible` });
    }
  });

const common = { id: z.string().min(1), enabled: z.boolean(), title: z.string() };

function section<T extends z.ZodLiteral<string>, S extends z.ZodRawShape>(type: T, settings: S) {
  return z.object({ ...common, type, settings: z.object(settings) });
}

export const quoteSectionSchema = z.discriminatedUnion('type', [
  section(z.literal('header'), {
    logoPosition: z.enum(['left', 'right', 'center']),
    logoHeightMm: z.number().min(8).max(40),
    titleText: z.string(),
    showSellerFields: z.array(z.enum(['gstin', 'pan', 'address', 'email', 'phone'])),
    metaFields: z.array(z.enum(['number', 'date', 'valid_until', 'rep'])),
  }),
  section(z.literal('client'), { showShipTo: z.boolean(), billToLabel: z.string(), shipToLabel: z.string() }),
  section(z.literal('text'), { defaultText: richTextDocSchema, repEditable: z.boolean() }),
  section(z.literal('line_items'), { columns: columnsSchema, groupByLabel: z.boolean() }),
  section(z.literal('totals'), {
    showSubtotal: z.boolean(),
    discountDisplay: z.enum(['combined', 'split', 'hidden']),
    showTaxBreakdown: z.boolean(),
    showRoundOff: z.boolean(),
    showAmountInWords: z.boolean(),
  }),
  section(z.literal('payment_schedule'), { defaultMilestones: z.array(milestoneSchema), repEditable: z.boolean() }),
  section(z.literal('terms'), { defaultText: richTextDocSchema, repEditable: z.boolean() }),
  section(z.literal('custom_fields'), { fields: z.array(z.object({ key: z.string().min(1), label: z.string() })) }),
  section(z.literal('signature'), { signatoryName: z.string(), signatoryTitle: z.string(), showClientAcceptance: z.boolean() }),
  section(z.literal('page_break'), {}),
]);

export type QuoteTheme = z.infer<typeof quoteThemeSchema>;
export type QuoteSection = z.infer<typeof quoteSectionSchema>;

const KNOWN = new Set<string>(PLACEHOLDERS);
const LEFTOVER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

function eachInline(blocks: RichTextBlock[], fn: (n: RichTextInline) => void): void {
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') b.content?.forEach(fn);
    else for (const item of b.content) eachInline(item.content, fn);
  }
}

/** Unknown placeholder keys: unknown placeholder nodes plus any leftover `{{x}}` text. Unique, in order. */
export function findUnknownPlaceholders(doc: RichTextDoc): string[] {
  const found: string[] = [];
  const add = (k: string) => {
    if (!found.includes(k)) found.push(k);
  };
  eachInline(doc.content, (n) => {
    if (n.type === 'placeholder') {
      if (!KNOWN.has(n.attrs.key)) add(n.attrs.key);
    } else if (n.type === 'text') {
      for (const m of n.text.matchAll(LEFTOVER_RE)) add(m[1]);
    }
  });
  return found;
}

export const quoteTemplateBodySchema = z
  .object({ theme: quoteThemeSchema, sections: z.array(quoteSectionSchema) })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.sections.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['sections', i, 'id'], message: `Duplicate section id "${s.id}"` });
      seen.add(s.id);
    });
    for (const type of ['line_items', 'totals'] as const) {
      const idx = body.sections.flatMap((s, i) => (s.type === type ? [i] : []));
      if (idx.length !== 1) {
        ctx.addIssue({ code: 'custom', path: ['sections'], message: `Template needs exactly one ${type} section (found ${idx.length})` });
      } else if (!body.sections[idx[0]].enabled) {
        ctx.addIssue({ code: 'custom', path: ['sections', idx[0], 'enabled'], message: `The ${type} section must be enabled` });
      }
    }
    const li = body.sections.findIndex((s) => s.type === 'line_items');
    const tot = body.sections.findIndex((s) => s.type === 'totals');
    if (li >= 0 && tot >= 0 && tot < li) {
      ctx.addIssue({ code: 'custom', path: ['sections', tot], message: 'The totals section must come after line_items' });
    }
    body.sections.forEach((s, i) => {
      if (s.type === 'text' || s.type === 'terms') {
        const unknown = findUnknownPlaceholders(s.settings.defaultText);
        if (unknown.length) {
          ctx.addIssue({ code: 'custom', path: ['sections', i, 'settings', 'defaultText'], message: `Unknown placeholder(s): ${unknown.join(', ')}` });
        }
      } else if (s.type === 'payment_schedule') {
        const sum = s.settings.defaultMilestones.reduce((a, m) => a + m.percentBps, 0);
        if (sum !== 10_000) {
          ctx.addIssue({ code: 'custom', path: ['sections', i, 'settings', 'defaultMilestones'], message: `Milestones must sum to 10000 bps (got ${sum})` });
        }
      }
    });
  });

export type QuoteTemplateBody = z.infer<typeof quoteTemplateBodySchema>;

export type SectionContent = { text?: RichTextDoc; milestones?: { label: string; percentBps: number }[]; terms?: RichTextDoc };
export type QuoteContent = Record<string, SectionContent>;

type PlaceholderValues = Partial<Record<Placeholder, string | null>>;

function resolveInlines(nodes: RichTextInline[] | undefined, values: PlaceholderValues): RichTextInline[] {
  const lookup = (k: string) => (KNOWN.has(k) ? (values[k as Placeholder] ?? '') : null);
  const out: RichTextInline[] = [];
  for (const n of nodes ?? []) {
    if (n.type === 'placeholder') {
      const v = lookup(n.attrs.key) ?? '';
      if (v) out.push({ type: 'text', text: v });
    } else if (n.type === 'text') {
      const text = n.text.replace(LEFTOVER_RE, (whole, k: string) => lookup(k) ?? whole);
      if (text) out.push({ ...n, text });
    } else out.push(n);
  }
  return out;
}

function resolveBlocks(blocks: RichTextBlock[], values: PlaceholderValues): RichTextBlock[] {
  return blocks.map((b): RichTextBlock => {
    if (b.type === 'paragraph') return { ...b, content: resolveInlines(b.content, values) };
    if (b.type === 'heading') return { ...b, content: resolveInlines(b.content, values) };
    return { ...b, content: b.content.map((li) => ({ ...li, content: resolveBlocks(li.content, values) })) };
  });
}

/** Replace placeholder nodes (and known leftover `{{key}}` text) with values; null/missing become ''. */
export function resolvePlaceholders(doc: RichTextDoc, values: PlaceholderValues): RichTextDoc {
  return { type: 'doc', content: resolveBlocks(doc.content, values) };
}

function defaultSectionContent(s: QuoteSection): SectionContent | null {
  if (s.type === 'text') return { text: structuredClone(s.settings.defaultText) };
  if (s.type === 'terms') return { terms: structuredClone(s.settings.defaultText) };
  if (s.type === 'payment_schedule') return { milestones: s.settings.defaultMilestones.map((m) => ({ ...m })) };
  return null;
}

export function defaultContentFor(body: QuoteTemplateBody): QuoteContent {
  const out: QuoteContent = {};
  for (const s of body.sections) {
    const c = defaultSectionContent(s);
    if (c) out[s.id] = c;
  }
  return out;
}

function fitsType(type: QuoteSection['type'], c: SectionContent): boolean {
  if (type === 'text') return c.text !== undefined;
  if (type === 'terms') return c.terms !== undefined;
  if (type === 'payment_schedule') return c.milestones !== undefined;
  return false;
}

/** Keep content for section ids that still exist (and still fit the section type), drop removed ids, add defaults for the rest. */
export function mergeContentForTemplate(body: QuoteTemplateBody, previous: QuoteContent): QuoteContent {
  const defaults = defaultContentFor(body);
  const out: QuoteContent = {};
  for (const s of body.sections) {
    if (!Object.hasOwn(defaults, s.id)) continue;
    const prev = Object.hasOwn(previous, s.id) ? previous[s.id] : undefined;
    out[s.id] = prev && fitsType(s.type, prev) ? prev : defaults[s.id];
  }
  return out;
}
