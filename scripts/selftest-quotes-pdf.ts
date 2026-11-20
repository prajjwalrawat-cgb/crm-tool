/**
 * Self-test for the react-pdf QuoteDocument (renders real PDFs, no DB).
 *   pnpm selftest:quotes-pdf
 */
import { renderToBuffer } from '@react-pdf/renderer';
import { extractText } from 'unpdf';

import { defaultTemplateBody } from '../src/lib/quotes/default-template';
import { amountInWords } from '../src/lib/quotes/pdf/amount-in-words';
import { formatBps, formatMoney } from '../src/lib/quotes/pdf/context';
import { registerQuoteFonts } from '../src/lib/quotes/pdf/fonts';
import { QuoteDocument, type QuoteRenderInput } from '../src/lib/quotes/pdf/quote-document';
import { renderQuotePdfServer } from '../src/lib/quotes/pdf/render-server';
import { sampleRenderInput } from '../src/lib/quotes/pdf/sample-data';
import { richTextFromPlain } from '../src/lib/quotes/rich-text';
import type { QuoteTemplateBody } from '../src/lib/quotes/template-schema';
import { computeQuoteTotals } from '../src/lib/quotes/totals';

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
  for (const g of base.quote.totals.taxGroups) {
    const cgst = Math.round(g.taxMinor / 2);
    const want = [`CGST @ ${formatBps(g.rateBps / 2)} ${formatMoney(cgst)}`, `SGST @ ${formatBps(g.rateBps / 2)} ${formatMoney(g.taxMinor - cgst)}`];
    check(`intra-state ${formatBps(g.rateBps)} CGST + SGST amounts are the halves`, want.every((w) => main.text.includes(w)), want.join(' | '));
  }
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
  for (const g of sampleRenderInput(defaultTemplateBody(), { interState: true }).quote.totals.taxGroups) {
    const want = `IGST @ ${formatBps(g.rateBps)} ${formatMoney(g.taxMinor)}`;
    check(`inter-state ${formatBps(g.rateBps)} IGST amount is the group tax`, inter.text.includes(want), want);
  }

  // Place of supply follows the consignee: seller 29, buyer 29, ship-to 27 → IGST
  const shipped = sampleRenderInput(defaultTemplateBody());
  shipped.quote.consignee = { name: 'Globex Pune plant', address: 'MIDC Chakan', city: 'Pune', state: 'Maharashtra', stateCode: '27', gstin: '27AAACG5678K2Z1' };
  const sh = await render(shipped);
  check('consignee in another state → IGST', sh.text.includes('IGST') && !sh.text.includes('CGST'));

  // Round-off: printed total, round-off row, words and milestone split all use the rounded figure
  const rounded = defaultTemplateBody();
  for (const s of rounded.sections) if (s.type === 'totals') s.settings.showRoundOff = true;
  const paise = sampleRenderInput(rounded, {
    lines: [{ description: 'Odd-priced item', hsnSac: '997331', unit: 'Nos', quantity: 1, rateMinor: 100_033, discountBps: 0, taxRateBps: 1800, groupLabel: null }],
  });
  const exact = paise.quote.totals.totalMinor;
  const payable = Math.round(exact / 100) * 100;
  check('round-off sample has paise', exact % 100 !== 0, String(exact));
  const ro = await render(paise);
  check('rounded total printed', ro.text.includes(`Total ${formatMoney(payable)}`), formatMoney(payable));
  check('round-off row printed', ro.text.includes(`Round off ${formatMoney(payable - exact)}`), formatMoney(payable - exact));
  check('amount in words uses rounded total', ro.text.includes(amountInWords(payable, 'INR')));
  const milestoneMinor = [...ro.text.matchAll(/(?:Advance with order|On delivery) \d+% -?₹([\d,]+\.\d{2})/g)].map((m) => Math.round(Number(m[1].replace(/,/g, '')) * 100));
  check('milestones sum to the rounded total', milestoneMinor.length === 2 && milestoneMinor.reduce((a, b) => a + b, 0) === payable, milestoneMinor.join('+'));

  // Server render used by "mark as sent"
  const served = await renderQuotePdfServer(sampleRenderInput(defaultTemplateBody()));
  check('renderQuotePdfServer returns %PDF bytes', served instanceof Uint8Array && Buffer.from(served.subarray(0, 4)).toString('latin1') === '%PDF');

  // Every font family renders
  for (const fontFamily of ['inter', 'roboto'] as const) {
    const b = defaultTemplateBody();
    b.theme.fontFamily = fontFamily;
    const r = await render(sampleRenderInput(b));
    check(`${fontFamily} renders ₹`, r.text.includes('₹'));
  }

  // ---- Final review fixes ----
  check('formatBps: 18%', formatBps(1800) === '18%');
  check('formatBps: 2.5%', formatBps(250) === '2.5%');
  check('formatBps: 3 decimals for half of a 0.25% slab', formatBps(12.5) === '0.125%', formatBps(12.5));
  check('formatBps: trailing zeros trimmed', formatBps(150) === '1.5%' && formatBps(0) === '0%');
  const slab = await render(
    sampleRenderInput(defaultTemplateBody(), {
      lines: [{ description: 'Rough diamonds', hsnSac: '7102', unit: 'Ct', quantity: 1, rateMinor: 1_000_000, discountBps: 0, taxRateBps: 25, groupLabel: null }],
    }),
  );
  check('0.25% slab intra-state prints CGST @ 0.125% and SGST @ 0.125%', slab.text.includes('CGST @ 0.125%') && slab.text.includes('SGST @ 0.125%'));

  // Totals rows per discount display. The sample has a 10% line discount;
  // add an overall discount so "split" has both rows.
  const withOverall = (display: 'combined' | 'split' | 'hidden') => {
    const b = defaultTemplateBody();
    for (const s of b.sections) if (s.type === 'totals') s.settings.discountDisplay = display;
    const input = sampleRenderInput(b);
    const lines = input.quote.items.map((i) => ({ quantity: Number(i.quantity), rateMinor: i.rateMinor, discountBps: i.discountBps, taxRateBps: i.taxRateBps }));
    const t = computeQuoteTotals(lines, { type: 'amount', valueMinor: 1_000_000 });
    input.quote = { ...input.quote, overallDiscountType: 'amount', overallDiscountValue: 1_000_000, totals: t, items: input.quote.items.map((i, k) => ({ ...i, totals: t.lines[k] })) };
    return input;
  };
  const rupees = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
  const totalsRows = (text: string) =>
    [...text.matchAll(/(Subtotal|Line discounts|Overall discount|Discount|Taxable value|[CSI]GST @ [\d.]+%|Total) (-?)₹([\d,]+\.\d{2})/g)].map((m) => ({
      label: m[1],
      minor: (m[2] ? -1 : 1) * rupees(m[3]),
    }));

  const hiddenIn = withOverall('hidden');
  const ht = hiddenIn.quote.totals;
  const hid = totalsRows((await render(hiddenIn)).text);
  const hSub = hid.find((r) => r.label === 'Subtotal');
  const hTax = hid.filter((r) => /GST @/.test(r.label)).reduce((a, r) => a + r.minor, 0);
  const hTotal = hid.find((r) => r.label === 'Total');
  check(
    'hidden discount: printed Subtotal + GST rows = Total, Subtotal is the taxable value, no discount rows',
    ht.discountMinor > 0 &&
      hSub?.minor === ht.taxableMinor &&
      hTotal?.minor === ht.totalMinor &&
      hSub.minor + hTax === hTotal.minor &&
      !hid.some((r) => /discount|Taxable value/i.test(r.label)),
    JSON.stringify(hid),
  );

  const splitIn = withOverall('split');
  const st = splitIn.quote.totals;
  const spl = totalsRows((await render(splitIn)).text);
  const val = (rows: typeof spl, label: string) => rows.find((r) => r.label === label)?.minor;
  check(
    'split discount: Subtotal, Line discounts, Overall discount, Taxable value rows add up',
    val(spl, 'Subtotal') === st.subtotalMinor &&
      val(spl, 'Line discounts') === -st.lineDiscountMinor &&
      val(spl, 'Overall discount') === -st.overallDiscountMinor &&
      val(spl, 'Taxable value') === st.taxableMinor &&
      st.subtotalMinor - st.lineDiscountMinor - st.overallDiscountMinor === st.taxableMinor &&
      val(spl, 'Discount') === undefined,
    JSON.stringify(spl),
  );

  const combIn = withOverall('combined');
  const ct = combIn.quote.totals;
  const comb = totalsRows((await render(combIn)).text);
  const combTax = comb.filter((r) => /GST @/.test(r.label)).reduce((a, r) => a + r.minor, 0);
  check(
    'combined discount: one Discount row, Taxable value + GST = Total',
    val(comb, 'Subtotal') === ct.subtotalMinor &&
      val(comb, 'Discount') === -ct.discountMinor &&
      val(comb, 'Line discounts') === undefined &&
      val(comb, 'Taxable value') === ct.taxableMinor &&
      ct.taxableMinor + combTax === val(comb, 'Total'),
    JSON.stringify(comb),
  );

  // Locked sections print the template default whatever the quote content says.
  const lockedBody = defaultTemplateBody();
  for (const s of lockedBody.sections) {
    if (s.type === 'text' || s.type === 'terms' || s.type === 'payment_schedule') s.settings.repEditable = false;
  }
  const lockedIn = sampleRenderInput(lockedBody);
  lockedIn.quote.content = {
    intro: { text: richTextFromPlain('FORGED intro') },
    terms: { terms: richTextFromPlain('FORGED terms') },
    payment_schedule: { milestones: [{ label: 'FORGED milestone', percentBps: 10_000 }] },
  };
  const lk = await render(lockedIn);
  check(
    'locked text/terms/payment schedule print the template defaults, not quote content',
    !lk.text.includes('FORGED') && lk.text.includes('Please find our quotation') && lk.text.includes('Prices are in INR') && lk.text.includes('Advance with order'),
  );
  const openIn = sampleRenderInput(defaultTemplateBody());
  openIn.quote.content = { ...openIn.quote.content, terms: { terms: richTextFromPlain('Rep terms') } };
  check('editable terms print the quote content', (await render(openIn)).text.includes('Rep terms'));
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
