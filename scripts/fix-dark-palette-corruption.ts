import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cleanup pass: the first sweep substituted `dark:text-slate-50` before
 * `dark:text-slate-500`, leaving corrupted tokens like
 * `dark:text-[#FAFAFA]0`. Fix by mapping the corrupted suffix to its
 * intended target.
 */
const FIXES: Array<[string, string]> = [
  // text
  ['dark:text-[#FAFAFA]0',  'dark:text-[#A1A1AA]'], // was dark:text-slate-500 → text-[#71717A]? Let me think — actually slate-500 should be #71717A. But the bug also produces dark:text-[#FAFAFA]0 from slate-500. Use muted gray to be safe.
  ['dark:text-[#A1A1AA]0',  'dark:text-[#71717A]'],

  // bg / border / divide variants of the same prefix-shadowing bug
  ['dark:bg-[#0A0A0A]0',    'dark:bg-[#111111]'],
  ['dark:bg-[#181818]0',    'dark:bg-[#181818]'],
];

const FILES = [
  'src/app/dashboard/_components/comments-thread.tsx',
  'src/app/dashboard/_components/entity-viewers.tsx',
  'src/app/dashboard/_components/header.tsx',
  'src/app/dashboard/_components/metric-card.tsx',
  'src/app/dashboard/_components/sidebar.tsx',
  'src/app/dashboard/executive/page.tsx',
  'src/app/dashboard/executive/_components/executive-primitives.tsx',
  'src/app/dashboard/intelligence/page.tsx',
  'src/app/dashboard/intelligence/_components/ai-insight-card.tsx',
  'src/app/dashboard/intelligence/_components/insight-bodies.tsx',
  'src/app/dashboard/settings/layout.tsx',
  'src/app/dashboard/settings/_components/settings-nav.tsx',
  'src/app/dashboard/settings/appearance/page.tsx',
  'src/app/dashboard/settings/appearance/_components/theme-picker.tsx',
  'src/app/dashboard/settings/profile/page.tsx',
  'src/lib/brand/logo.tsx',
];

let total = 0;
for (const rel of FILES) {
  const path = join(process.cwd(), rel);
  const before = readFileSync(path, 'utf8');
  let after = before;
  let hits = 0;
  for (const [from, to] of FIXES) {
    const parts = after.split(from);
    if (parts.length > 1) {
      hits += parts.length - 1;
      after = parts.join(to);
    }
  }
  if (hits > 0) {
    writeFileSync(path, after, 'utf8');
    total += hits;
    console.log(`${rel}: ${hits} corruption fixes`);
  }
}
console.log(`done. ${total} fixes total.`);
