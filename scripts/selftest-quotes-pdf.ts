/**
 * Self-test for the react-pdf QuoteDocument (renders real PDFs, no DB).
 *   pnpm selftest:quotes-pdf
 */
import { renderToBuffer } from '@react-pdf/renderer';
import { extractText } from 'unpdf';

import { defaultTemplateBody } from '../src/lib/quotes/default-template';
import { amountInWords } from '../src/lib/quotes/pdf/amount-in-words';
import { registerQuoteFonts } from '../src/lib/quotes/pdf/fonts';
import { QuoteDocument, type QuoteRenderInput } from '../src/lib/quotes/pdf/quote-document';
import { sampleRenderInput } from '../src/lib/quotes/pdf/sample-data';
import type { QuoteTemplateBody } from '../src/lib/quotes/template-schema';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function render(input: QuoteRenderInput): Promise<{ buf: Buffer; text: string; pageTexts: string[]; pages: number }> {
  const buf = await renderToBuffer(QuoteDocument(input));
  const { text, totalPages } = await extractText(new Uint8Array(buf), { mergePages: false });
  const pageTexts = text.map((t) => t.replace(/\s+/g, ' '));
  return { buf, text: pageTexts.join(' '), pageTexts, pages: totalPages };
}

async function main(): Promise<void> {
  // amountInWords (moved from invoices/pdf.ts, output unchanged)
  check('words: zero', amountInWords(0, 'INR') === 'INR Zero Only');
  check('words: lakh + paise', amountInWords(12_345_605, 'INR') === 'INR One Lakh Twenty Three Thousand Four Hundred Fifty Six and Five Paise Only');
  check('words: crore', amountInWords(2_500_000_000, 'INR') === 'INR Two Crore Fifty Lakh Only');

  registerQuoteFonts('server');
  registerQuoteFonts('server'); // idempotent

  const base = sampleRenderInput(defaultTemplateBody());
  const main = await render(base);
  check('starts with %PDF', main.buf.subarray(0, 4).toString('latin1') === '%PDF');
  check('contains ₹', main.text.includes('₹'));
  check('contains quote number', main.text.includes(base.quote.quoteNumber), base.quote.quoteNumber);
  check('intra-state shows CGST', main.text.includes('CGST') && main.text.includes('SGST'));
  check('intra-state hides IGST', !main.text.includes('IGST'));
  const words = amountInWords(base.quote.totals.totalMinor, 'INR');
  check('contains amount in words', main.text.includes(words), words);
  check('placeholders resolved in intro', main.text.includes(`Dear ${base.quote.buyer.contactName}`) && !main.text.includes('{{'));
  check('text extracts without ligature loss', main.text.includes('Please find our quotation'));
  check('terms rendered', main.text.includes('Prices are in INR'));
  check('payment schedule rendered', main.text.includes('Advance with order'));
  check('page footer with page numbers', main.pageTexts[0].includes('Page 1 of'));

  // Every optional section disabled
  const minimal: QuoteTemplateBody = defaultTemplateBody();
  minimal.sections = minimal.sections.map((s) => (s.type === 'line_items' || s.type === 'totals' ? s : { ...s, enabled: false }));
  const min = await render(sampleRenderInput(minimal));
  check('minimal body renders', min.buf.subarray(0, 4).toString('latin1') === '%PDF');
  check('minimal body skips disabled sections', !min.text.includes('Advance with order') && !min.text.includes('Prices are in INR'));

  // Every section type, incl. page_break and custom_fields
  const full: QuoteTemplateBody = defaultTemplateBody();
  full.sections.splice(2, 0, { id: 'cf', type: 'custom_fields', enabled: true, title: 'Project details', settings: { fields: [{ key: 'po', label: 'PO ref' }, { key: 'missing', label: 'Missing field' }] } });
  full.sections.push({ id: 'pb', type: 'page_break', enabled: true, title: 'Page break', settings: {} });
  full.sections.push({ id: 'tail', type: 'text', enabled: true, title: 'Closing', settings: { repEditable: false, defaultText: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Why us', marks: [{ type: 'bold' }] }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fast delivery' }] }] }] }, { type: 'orderedList', attrs: { start: 3, type: null }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Local support' }, { type: 'hardBreak' }, { type: 'text', text: 'all week', marks: [{ type: 'italic' }] }] }] }] }] } } });
  const fullInput = sampleRenderInput(full);
  fullInput.dealCustomFields = { po: 'PO-7781' };
  const fl = await render(fullInput);
  check('custom field value shown', fl.text.includes('PO-7781'));
  check('missing custom field shows —', fl.text.includes('Missing field —') || fl.text.includes('Missing field: —'));
  check('page_break adds a page', fl.pages >= 2, String(fl.pages));
  check('rich text lists render', fl.text.includes('Fast delivery') && fl.text.includes('3. Local support') && fl.text.includes('all week'));

  // 60 line items wrap across pages
  const many = await render(sampleRenderInput(defaultTemplateBody(), { itemCount: 60 }));
  check('60 items → ≥ 2 pages', many.pages >= 2, String(many.pages));
  check('60th item present', many.text.includes('Sample item 60'));
  check('table header repeats on page 2', many.pageTexts[1]?.includes('Description') && many.pageTexts[1]?.includes('HSN/SAC'));

  // Inter-state
  const inter = await render(sampleRenderInput(defaultTemplateBody(), { interState: true }));
  check('inter-state shows IGST', inter.text.includes('IGST'));
  check('inter-state hides CGST', !inter.text.includes('CGST'));

  // Every font family renders
  for (const fontFamily of ['inter', 'roboto'] as const) {
    const b = defaultTemplateBody();
    b.theme.fontFamily = fontFamily;
    const r = await render(sampleRenderInput(b));
    check(`${fontFamily} renders ₹`, r.text.includes('₹'));
  }
}

main()
  .catch((e) => {
    check('no exception', false, e instanceof Error ? e.stack : String(e));
  })
  .finally(() => {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  (${r.detail})` : ''}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passing`);
    process.exit(exitCode);
  });
