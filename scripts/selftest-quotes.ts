/**
 * Self-test for quote totals (pure money maths).
 *   pnpm selftest:quotes
 */
import { computeQuoteTotals, QuoteTotalsError } from '../src/lib/quotes/totals';
import {
  quoteTemplateBodySchema,
  resolvePlaceholders,
  defaultContentFor,
  mergeContentForTemplate,
  findUnknownPlaceholders,
  type QuoteTemplateBody,
} from '../src/lib/quotes/template-schema';
import { richTextFromPlain, type RichTextDoc } from '../src/lib/quotes/rich-text';
import { defaultTemplateBody } from '../src/lib/quotes/default-template';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof QuoteTotalsError && e.code === code;
  }
}

const A = { quantity: 2, rateMinor: 50_000, discountBps: 0, taxRateBps: 1800 };
const B = { quantity: 1, rateMinor: 100_000, discountBps: 1000, taxRateBps: 500 };
const t = computeQuoteTotals([A, B], { type: 'amount', valueMinor: 19_000 });
check('subtotal is gross', t.subtotalMinor === 200_000);
check('allocation proportional', t.lines[0].allocatedDiscountMinor === 10_000 && t.lines[1].allocatedDiscountMinor === 9_000);
check('discount = line + overall', t.discountMinor === 29_000);
check('tax per line', t.lines[0].taxMinor === 16_200 && t.lines[1].taxMinor === 4_050);
check('tax groups ascending', JSON.stringify(t.taxGroups.map((g) => g.rateBps)) === '[500,1800]');
check('total', t.totalMinor === 171_000 + 20_250);
const r = computeQuoteTotals([1, 2, 3].map(() => ({ quantity: 1, rateMinor: 10_000, discountBps: 0, taxRateBps: 0 })), { type: 'amount', valueMinor: 100 });
check('remainder to first-largest', r.lines.map((l) => l.allocatedDiscountMinor).join() === '34,33,33');
check('percent overall', computeQuoteTotals([A, B], { type: 'percent', bps: 500 }).overallDiscountMinor === 9_500);
check('100% overall → zero tax, not negative', (() => {
  const z = computeQuoteTotals([A], { type: 'percent', bps: 10000 });
  return z.taxMinor === 0 && z.totalMinor === 0;
})());
check('overall > subtotal throws', throwsCode(() => computeQuoteTotals([A], { type: 'amount', valueMinor: 100_001 }), 'discount_exceeds_subtotal'));
check('fractional qty rounds', computeQuoteTotals([{ quantity: 1.333, rateMinor: 999, discountBps: 0, taxRateBps: 0 }], { type: 'none' }).subtotalMinor === 1332);
check('empty quote is all zeros', computeQuoteTotals([], { type: 'none' }).totalMinor === 0);

// Extra edge cases
check('negative qty throws', throwsCode(() => computeQuoteTotals([{ ...A, quantity: -1 }], { type: 'none' }), 'invalid_input'));
check('negative rate throws', throwsCode(() => computeQuoteTotals([{ ...A, rateMinor: -1 }], { type: 'none' }), 'invalid_input'));
check('line discount bps > 10000 throws', throwsCode(() => computeQuoteTotals([{ ...A, discountBps: 10_001 }], { type: 'none' }), 'invalid_input'));
check('tax bps > 4000 throws', throwsCode(() => computeQuoteTotals([{ ...A, taxRateBps: 4_001 }], { type: 'none' }), 'invalid_input'));
check('overall percent bps > 10000 throws', throwsCode(() => computeQuoteTotals([A], { type: 'percent', bps: 10_001 }), 'invalid_input'));
check('negative overall amount throws', throwsCode(() => computeQuoteTotals([A], { type: 'amount', valueMinor: -1 }), 'invalid_input'));
check('zero-amount line gets no allocation', (() => {
  const z = computeQuoteTotals([{ ...A, rateMinor: 0 }, B], { type: 'amount', valueMinor: 100 });
  return z.lines[0].allocatedDiscountMinor === 0 && z.lines[1].allocatedDiscountMinor === 100;
})());
check('allocations sum to overall', (() => {
  const x = computeQuoteTotals([A, B, { ...A, rateMinor: 333 }], { type: 'amount', valueMinor: 12_345 });
  return x.lines.reduce((s, l) => s + l.allocatedDiscountMinor, 0) === 12_345;
})());
check('tax groups skip zero-taxable rates', (() => {
  const z = computeQuoteTotals([{ ...A, rateMinor: 0 }, B], { type: 'none' });
  return JSON.stringify(z.taxGroups.map((g) => g.rateBps)) === '[500]';
})());

const noNeg = (x: ReturnType<typeof computeQuoteTotals>, o: number) =>
  x.lines.every((l) => l.taxableMinor >= 0) && x.lines.reduce((s, l) => s + l.allocatedDiscountMinor, 0) === o && x.overallDiscountMinor === o;
check('remainder never makes taxable negative (1-paise lines)', (() => {
  const x = computeQuoteTotals([1, 2, 3].map(() => ({ quantity: 1, rateMinor: 1, discountBps: 0, taxRateBps: 0 })), { type: 'amount', valueMinor: 2 });
  return noNeg(x, 2);
})());
check('remainder never makes taxable negative (4 x 10000, 39999)', (() => {
  const x = computeQuoteTotals([1, 2, 3, 4].map(() => ({ quantity: 1, rateMinor: 10_000, discountBps: 0, taxRateBps: 0 })), { type: 'amount', valueMinor: 39_999 });
  return noNeg(x, 39_999);
})());
check('huge quantity throws invalid_input', throwsCode(() => computeQuoteTotals([{ ...A, quantity: 1e300 }], { type: 'none' }), 'invalid_input'));

check('quantity x rate overflowing to Infinity throws invalid_input', throwsCode(() => computeQuoteTotals([{ ...A, quantity: 1e200, rateMinor: 1e200 }], { type: 'none' }), 'invalid_input'));


// ---- Task 3: template schema, rich text, placeholders ----
const plainText = (d: RichTextDoc): string => JSON.stringify(d).match(/"text":"[^"]*"/g)?.join('') ?? '';
const phDoc = (...keys: string[]): RichTextDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: keys.flatMap((k) => [{ type: 'text' as const, text: 'x ' }, { type: 'placeholder' as const, attrs: { key: k } }]) }],
});
const clone = (): QuoteTemplateBody => structuredClone(defaultTemplateBody());

check('defaultTemplateBody parses', quoteTemplateBodySchema.safeParse(defaultTemplateBody()).success);
check('default template section order', defaultTemplateBody().sections.map((x) => x.type).join() === 'header,client,text,line_items,totals,payment_schedule,terms,signature');
check('duplicate section id rejected', (() => {
  const b = clone();
  b.sections[1].id = b.sections[0].id;
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('no totals section rejected', (() => {
  const b = clone();
  b.sections = b.sections.filter((x) => x.type !== 'totals');
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('totals before line_items rejected', (() => {
  const b = clone();
  const i = b.sections.findIndex((x) => x.type === 'line_items');
  const j = b.sections.findIndex((x) => x.type === 'totals');
  [b.sections[i], b.sections[j]] = [b.sections[j], b.sections[i]];
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('disabled line_items rejected', (() => {
  const b = clone();
  b.sections.find((x) => x.type === 'line_items')!.enabled = false;
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('milestones summing to 9000 rejected', (() => {
  const b = clone();
  const ps = b.sections.find((x) => x.type === 'payment_schedule');
  if (ps?.type !== 'payment_schedule') return false;
  ps.defaultMilestones = [{ label: 'A', percentBps: 4000 }, { label: 'B', percentBps: 5000 }];
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('hidden description column rejected', (() => {
  const b = clone();
  const li = b.sections.find((x) => x.type === 'line_items');
  if (li?.type !== 'line_items') return false;
  li.columns.find((c) => c.key === 'description')!.visible = false;
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('unknown placeholder default rejected, message names it', (() => {
  const b = clone();
  const tx = b.sections.find((x) => x.type === 'text');
  if (tx?.type !== 'text') return false;
  tx.defaultText = phDoc('deal.amount');
  const r = quoteTemplateBodySchema.safeParse(b);
  return !r.success && r.error.issues.some((i) => i.message.includes('deal.amount'));
})());
check('leftover {{x}} text counts as unknown', findUnknownPlaceholders(richTextFromPlain('Hi {{deal.amount}}')).join() === 'deal.amount');
check('known placeholder node is not unknown', findUnknownPlaceholders(phDoc('client.name')).length === 0);
check('richText schema rejects disallowed node', !quoteTemplateBodySchema.safeParse({ ...clone(), sections: [{ id: 'x', type: 'text', enabled: true, title: 't', repEditable: true, defaultText: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] } }] }).success);
check('resolvePlaceholders fills and blanks', (() => {
  const out = resolvePlaceholders(phDoc('client.name', 'client.contact'), { 'client.name': 'Acme', 'client.contact': null });
  const txt = plainText(out);
  return txt.includes('Acme') && !txt.includes('{{') && !JSON.stringify(out).includes('placeholder');
})());
check('mergeContentForTemplate keeps, drops, adds', (() => {
  const b = clone();
  const prev = defaultContentFor(b);
  const edited = richTextFromPlain('edited');
  const tx = b.sections.find((x) => x.type === 'text')!;
  prev[tx.id] = { text: edited };
  prev['gone'] = { text: richTextFromPlain('old') };
  delete prev[b.sections.find((x) => x.type === 'terms')!.id];
  const m = mergeContentForTemplate(b, prev);
  return m[tx.id].text === edited && !('gone' in m) && !!m[b.sections.find((x) => x.type === 'terms')!.id]?.terms;
})());

for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? `\n      ${x.detail}` : ''}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(exitCode);
