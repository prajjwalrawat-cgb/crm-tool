/**
 * Restricted TipTap/ProseMirror JSON used by quote templates and quotes.
 * Framework-free (zod only) so it runs on server and client.
 * Allowed nodes: doc, paragraph, heading(2|3), bulletList, orderedList,
 * listItem, text, hardBreak, placeholder. Allowed marks: bold, italic.
 */
import { z } from 'zod';

export type RichTextMark = { type: 'bold' | 'italic' };
export type RichTextText = { type: 'text'; text: string; marks?: RichTextMark[] };
export type RichTextHardBreak = { type: 'hardBreak' };
export type RichTextPlaceholder = { type: 'placeholder'; attrs: { key: string } };
export type RichTextInline = RichTextText | RichTextHardBreak | RichTextPlaceholder;
export type RichTextParagraph = { type: 'paragraph'; content?: RichTextInline[] };
export type RichTextHeading = { type: 'heading'; attrs: { level: 2 | 3 }; content?: RichTextInline[] };
export type RichTextListItem = { type: 'listItem'; content: RichTextBlock[] };
export type RichTextList = { type: 'bulletList' | 'orderedList'; content: RichTextListItem[] };
export type RichTextBlock = RichTextParagraph | RichTextHeading | RichTextList;
export type RichTextDoc = { type: 'doc'; content: RichTextBlock[] };

const markSchema = z.object({ type: z.enum(['bold', 'italic']) }).strict();

const inlineSchema: z.ZodType<RichTextInline> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1), marks: z.array(markSchema).optional() }).strict(),
  z.object({ type: z.literal('hardBreak') }).strict(),
  z.object({ type: z.literal('placeholder'), attrs: z.object({ key: z.string().min(1) }).strict() }).strict(),
]);

const paragraphSchema = z.object({ type: z.literal('paragraph'), content: z.array(inlineSchema).optional() }).strict();
const headingSchema = z
  .object({
    type: z.literal('heading'),
    attrs: z.object({ level: z.union([z.literal(2), z.literal(3)]) }).strict(),
    content: z.array(inlineSchema).optional(),
  })
  .strict();

const blockSchema: z.ZodType<RichTextBlock> = z.lazy(() => {
  const listItem = z.object({ type: z.literal('listItem'), content: z.array(blockSchema).min(1) }).strict();
  return z.union([
    paragraphSchema,
    headingSchema,
    z.object({ type: z.literal('bulletList'), content: z.array(listItem).min(1) }).strict(),
    z.object({ type: z.literal('orderedList'), content: z.array(listItem).min(1) }).strict(),
  ]);
});

export const richTextDocSchema: z.ZodType<RichTextDoc> = z
  .object({ type: z.literal('doc'), content: z.array(blockSchema) })
  .strict();

/** One paragraph per line; blank lines become empty paragraphs. */
export function richTextFromPlain(s: string): RichTextDoc {
  const lines = s.split(/\r\n|\r|\n/);
  return {
    type: 'doc',
    content: lines.map((line): RichTextParagraph => (line === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}
