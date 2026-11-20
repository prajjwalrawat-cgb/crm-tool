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
  isLockedContentSection,
  effectiveMilestones,
  effectiveSectionTerms,
  effectiveSectionText,
  quoteSectionSchema,
  type QuoteContent,
  type QuoteTemplateBody,
  type SectionContent,
} from '../src/lib/quotes/template-schema';
import { quoteContentSchema } from '../src/lib/quotes/schema';
import { richTextDocSchema, richTextFromPlain, type RichTextDoc } from '../src/lib/quotes/rich-text';
import { defaultTemplateBody } from '../src/lib/quotes/default-template';
import { can } from '../src/lib/rbac';
import { fiscalYearLabel, formatQuoteNumber } from '../src/lib/quotes/numbering';

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

check('qty x rate in integer maths: 1.005 x 100 = 101 (half up of 100.5)', computeQuoteTotals([{ quantity: 1.005, rateMinor: 100, discountBps: 0, taxRateBps: 0 }], { type: 'none' }).subtotalMinor === 101);
check('qty x rate: 0.015 x 100 = 2 (1.5 half up)', computeQuoteTotals([{ quantity: 0.015, rateMinor: 100, discountBps: 0, taxRateBps: 0 }], { type: 'none' }).subtotalMinor === 2);
check('qty x rate: large exact product', computeQuoteTotals([{ quantity: 99_999.999, rateMinor: 99_999_999, discountBps: 0, taxRateBps: 0 }], { type: 'none' }).subtotalMinor === 9_999_999_800_000);
check('quantity with 4 decimals throws invalid_input', throwsCode(() => computeQuoteTotals([{ ...A, quantity: 1.0005 }], { type: 'none' }), 'invalid_input'));
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
  ps.settings.defaultMilestones = [{ label: 'A', percentBps: 4000 }, { label: 'B', percentBps: 5000 }];
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('hidden description column rejected', (() => {
  const b = clone();
  const li = b.sections.find((x) => x.type === 'line_items');
  if (li?.type !== 'line_items') return false;
  li.settings.columns.find((c) => c.key === 'description')!.visible = false;
  return !quoteTemplateBodySchema.safeParse(b).success;
})());
check('unknown placeholder default rejected, message names it', (() => {
  const b = clone();
  const tx = b.sections.find((x) => x.type === 'text');
  if (tx?.type !== 'text') return false;
  tx.settings.defaultText = phDoc('deal.amount');
  const r = quoteTemplateBodySchema.safeParse(b);
  return !r.success && r.error.issues.some((i) => i.message.includes('deal.amount'));
})());
check('leftover {{x}} text counts as unknown', findUnknownPlaceholders(richTextFromPlain('Hi {{deal.amount}}')).join() === 'deal.amount');
check('known placeholder node is not unknown', findUnknownPlaceholders(phDoc('client.name')).length === 0);
const txt = (text: string, marks?: { type: string }[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const validRich = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [txt('a', [{ type: 'bold' }, { type: 'italic' }]), { type: 'hardBreak' }, { type: 'placeholder', attrs: { key: 'client.name' } }] },
    { type: 'heading', attrs: { level: 2 }, content: [txt('h')] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [txt('b')] }] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [txt('o')] }] }] },
  ],
};
check('richText accepts a valid doc', richTextDocSchema.safeParse(validRich).success);
check('richText rejects heading level 1', !richTextDocSchema.safeParse({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [txt('h')] }] }).success);
check('richText rejects underline mark', !richTextDocSchema.safeParse({ type: 'doc', content: [{ type: 'paragraph', content: [txt('a', [{ type: 'underline' }])] }] }).success);
check('richText rejects link mark', !richTextDocSchema.safeParse({ type: 'doc', content: [{ type: 'paragraph', content: [txt('a', [{ type: 'link' }])] }] }).success);
check('richText accepts TipTap orderedList attrs', richTextDocSchema.safeParse({ type: 'doc', content: [{ type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [txt('o')] }] }] }] }).success);
check('mergeContentForTemplate ignores previous content of a different type', (() => {
  const b = clone();
  const tx = b.sections.find((x) => x.type === 'text')!;
  const m = mergeContentForTemplate(b, { [tx.id]: { terms: richTextFromPlain('wrong shape') } });
  return m[tx.id].text !== undefined && m[tx.id].terms === undefined;
})());
check('mergeContentForTemplate ignores inherited keys', !!mergeContentForTemplate(clone(), JSON.parse('{"__proto__":{"x":1}}')));
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

// ---- Final review: locked (repEditable: false) sections always use the template default ----
const lockedClone = (): QuoteTemplateBody => {
  const b = clone();
  for (const x of b.sections) if (x.type === 'text' || x.type === 'terms' || x.type === 'payment_schedule') x.settings.repEditable = false;
  return b;
};
check('isLockedContentSection: only text/terms/payment_schedule with repEditable false', (() => {
  const unlocked = clone().sections.filter(isLockedContentSection).length === 0;
  const locked = lockedClone().sections.filter(isLockedContentSection).map((x) => x.type).sort().join();
  return unlocked && locked === 'payment_schedule,terms,text';
})());
check('mergeContentForTemplate: rep content for locked sections is replaced by the defaults', (() => {
  const b = lockedClone();
  const forged: QuoteContent = Object.fromEntries(
    b.sections.flatMap((x): [string, SectionContent][] =>
      x.type === 'text' ? [[x.id, { text: richTextFromPlain('FORGED') }]]
      : x.type === 'terms' ? [[x.id, { terms: richTextFromPlain('FORGED') }]]
      : x.type === 'payment_schedule' ? [[x.id, { milestones: [{ label: 'FORGED', percentBps: 10_000 }] }]]
      : [],
    ),
  );
  const m = mergeContentForTemplate(b, forged);
  return !JSON.stringify(m).includes('FORGED') && JSON.stringify(m) === JSON.stringify(defaultContentFor(b));
})());
check('defaultContentFor: locked sections carry the template defaults', (() => {
  const b = lockedClone();
  const c = defaultContentFor(b);
  const terms = b.sections.find((x) => x.type === 'terms');
  return terms?.type === 'terms' && JSON.stringify(c[terms.id].terms) === JSON.stringify(terms.settings.defaultText);
})());
check('effective* helpers: rep content when editable, default when locked', (() => {
  const open = clone();
  const locked = lockedClone();
  const pick = <T extends QuoteTemplateBody['sections'][number]['type']>(b: QuoteTemplateBody, t: T) =>
    b.sections.find((x) => x.type === t) as Extract<QuoteTemplateBody['sections'][number], { type: T }>;
  const rep = richTextFromPlain('rep');
  const ms = [{ label: 'All', percentBps: 10_000 }];
  const content = { intro: { text: rep }, terms: { terms: rep }, payment_schedule: { milestones: ms } };
  return (
    effectiveSectionText(pick(open, 'text'), content) === rep &&
    effectiveSectionTerms(pick(open, 'terms'), content) === rep &&
    effectiveMilestones(pick(open, 'payment_schedule'), content) === ms &&
    effectiveSectionText(pick(locked, 'text'), content) === pick(locked, 'text').settings.defaultText &&
    effectiveSectionTerms(pick(locked, 'terms'), content) === pick(locked, 'terms').settings.defaultText &&
    effectiveMilestones(pick(locked, 'payment_schedule'), content) === pick(locked, 'payment_schedule').settings.defaultMilestones &&
    effectiveSectionText(pick(open, 'text'), {}) === pick(open, 'text').settings.defaultText
  );
})());

// ---- Final review: quote content milestones must be non-empty and sum to 10000 bps ----
const msIssue = (milestones: { label: string; percentBps: number }[]) => {
  const r = quoteContentSchema.safeParse({ ps: { milestones } });
  return r.success ? null : r.error.issues.map((i) => i.path.join('.')).join('|');
};
check('content milestones 50/50/50 rejected at ps.milestones', msIssue([{ label: 'a', percentBps: 5000 }, { label: 'b', percentBps: 5000 }, { label: 'c', percentBps: 5000 }]) === 'ps.milestones');
check('content milestones 30/30 rejected at ps.milestones', msIssue([{ label: 'a', percentBps: 3000 }, { label: 'b', percentBps: 3000 }]) === 'ps.milestones');
check('content milestones [] rejected at ps.milestones', msIssue([]) === 'ps.milestones');
check('content milestones 50/50 accepted', msIssue([{ label: 'a', percentBps: 5000 }, { label: 'b', percentBps: 5000 }]) === null);
check('content without milestones accepted', quoteContentSchema.safeParse({ t: { text: richTextFromPlain('x') } }).success);

// ---- Final review: header seller email/phone are not offered (never printed) but still parse ----
check('starter header shows no seller email/phone', (() => {
  const h = defaultTemplateBody().sections.find((x) => x.type === 'header');
  return h?.type === 'header' && !h.settings.showSellerFields.some((f) => f === 'email' || f === 'phone');
})());
check('header schema still accepts seller email/phone (older templates)', (() => {
  const h = structuredClone(defaultTemplateBody().sections.find((x) => x.type === 'header')!);
  if (h.type !== 'header') return false;
  h.settings.showSellerFields = ['gstin', 'email', 'phone'];
  return quoteSectionSchema.safeParse(h).success;
})());

check('fiscalYearLabel 2026-11-20 start 4 = 2026-27', fiscalYearLabel('2026-11-20', 4) === '2026-27');
check('fiscalYearLabel 2027-03-31 start 4 = 2026-27', fiscalYearLabel('2027-03-31', 4) === '2026-27');
check('fiscalYearLabel 2027-04-01 start 4 = 2027-28', fiscalYearLabel('2027-04-01', 4) === '2027-28');
check('fiscalYearLabel start 1 = calendar year', fiscalYearLabel('2026-11-20', 1) === '2026');
const numFmt = { prefix: 'Q', separator: '/', includeFiscalYear: true, padding: 4 };
check('formatQuoteNumber with FY', formatQuoteNumber(numFmt, '2026-27', 42) === 'Q/2026-27/0042');
check('formatQuoteNumber without FY', formatQuoteNumber({ ...numFmt, includeFiscalYear: false }, null, 42) === 'Q/0042');

check('member can manageQuotes', can('member', 'manageQuotes'));
check('viewer cannot manageQuotes', !can('viewer', 'manageQuotes'));
check('manager can manageQuotes', can('manager', 'manageQuotes'));
check('manager cannot manageQuoteTemplates', !can('manager', 'manageQuoteTemplates'));
check('member cannot manageQuoteTemplates', !can('member', 'manageQuoteTemplates'));
check('admin can manageQuoteTemplates', can('admin', 'manageQuoteTemplates'));
check('owner can manageQuoteTemplates', can('owner', 'manageQuoteTemplates'));
check('viewer cannot manageQuoteTemplates', !can('viewer', 'manageQuoteTemplates'));

for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${!x.ok && x.detail ? `\n      ${x.detail}` : ''}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(exitCode);
