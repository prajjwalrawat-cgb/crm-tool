/**
 * Self-test for the quote template builder's pure pieces: the TipTap schema
 * matches RichTextDoc, and zod error paths map back to section ids.
 *   pnpm selftest:quote-builder
 */
import { getSchema } from '@tiptap/react';

import { groupTemplateErrors, issuesToFieldErrors } from '../src/app/dashboard/settings/quote-templates/_components/template-errors';
import { defaultTemplateBody } from '../src/lib/quotes/default-template';
import { richTextDocSchema, type RichTextDoc } from '../src/lib/quotes/rich-text';
import { quoteRichTextExtensions } from '../src/lib/quotes/rich-text-extensions';
import { quoteTemplateBodySchema } from '../src/lib/quotes/template-schema';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}
/** Deep equality ignoring object key order. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]));
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/* ----------------------------- TipTap schema ----------------------------- */

const schema = getSchema(quoteRichTextExtensions());
const nodes = Object.keys(schema.nodes).sort();
const marks = Object.keys(schema.marks).sort();
const ALLOWED_NODES = ['bulletList', 'doc', 'hardBreak', 'heading', 'listItem', 'orderedList', 'paragraph', 'placeholder', 'text'];
check('editor nodes = RichTextDoc nodes', same(nodes, ALLOWED_NODES), nodes.join(','));
check('editor marks = bold, italic', same(marks, ['bold', 'italic']), marks.join(','));

const full: RichTextDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Dear ', marks: [{ type: 'bold' }] },
        { type: 'placeholder', attrs: { key: 'client.name' } },
        { type: 'hardBreak' },
        { type: 'text', text: 'thanks', marks: [{ type: 'italic' }] },
      ],
    },
    { type: 'paragraph' },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] },
    {
      type: 'orderedList',
      attrs: { start: 1, type: null },
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }],
    },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Sub' }] },
  ],
};
const roundTrip = schema.nodeFromJSON(full).toJSON() as unknown;
check('editor JSON round-trip parses as RichTextDoc', richTextDocSchema.safeParse(roundTrip).success, JSON.stringify(roundTrip));
check('editor JSON round-trip is unchanged', same(roundTrip, full), JSON.stringify(roundTrip));

for (const s of defaultTemplateBody().sections) {
  if (s.type === 'text' || s.type === 'terms') {
    const rt = schema.nodeFromJSON(s.settings.defaultText).toJSON() as unknown;
    check(`default ${s.id} text round-trips`, richTextDocSchema.safeParse(rt).success && same(rt, s.settings.defaultText));
  }
}

/* ------------------------------ error mapping ----------------------------- */

const body = defaultTemplateBody();
const ids = body.sections.map((s) => s.id);
const ps = body.sections.findIndex((s) => s.type === 'payment_schedule');
const broken = structuredClone(body);
const psSection = broken.sections[ps];
if (psSection.type === 'payment_schedule') psSection.settings.defaultMilestones[0].percentBps = 1000;
broken.theme.primaryColor = 'red';
const parsed = quoteTemplateBodySchema.safeParse(broken);
check('broken body is invalid', !parsed.success);
if (!parsed.success) {
  const fe = issuesToFieldErrors(parsed.error.issues);
  check('field error key format', Object.hasOwn(fe, `sections.${ps}.settings.defaultMilestones`), Object.keys(fe).join(' | '));
  const g = groupTemplateErrors(fe, ids);
  check('milestone error maps to its section id', (g.sections.payment_schedule ?? []).some((m) => m.includes('10000')), JSON.stringify(g));
  check('theme error maps to theme', g.theme.length === 1 && g.theme[0].startsWith('primaryColor: '), JSON.stringify(g.theme));
}

const g2 = groupTemplateErrors(
  { name: ['Name is required'], 'body.sections.1.title': ['x'], sections: ['Template needs exactly one totals section'], 'sections.99.id': ['y'], _form: ['z'] },
  ids,
);
check('name errors', same(g2.name, ['Name is required']));
check('body. prefix stripped', same(g2.sections[ids[1]], ['x']));
check('section-level and out-of-range go to general', same(g2.general, ['Template needs exactly one totals section', 'y', 'z']));

/* --------------------------------- report -------------------------------- */

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(exitCode);
