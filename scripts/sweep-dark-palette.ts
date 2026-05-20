import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One-off sweep that rewrites the blue-tinted slate-* dark variants to
 * the new neutral grayscale palette (CP#16 hotfix).
 *
 * Substitutions are deliberately literal — no regex magic that might
 * touch unrelated occurrences. Each line is a `[from, to]` tuple.
 */
const SUBS: Array<[string, string]> = [
  // Page backgrounds.
  ['dark:bg-[#0B1020]', 'dark:bg-black'],

  // Surfaces / cards / drawers.
  ['dark:bg-[#111827]', 'dark:bg-[#0A0A0A]'],
  ['dark:bg-slate-900/60', 'dark:bg-[#0A0A0A]'],
  ['dark:bg-slate-900/40', 'dark:bg-[#0A0A0A]'],
  ['dark:bg-slate-900/30', 'dark:bg-[#111111]'],
  ['dark:bg-slate-900', 'dark:bg-[#0A0A0A]'],

  // Hovers / subtle elevation.
  ['dark:bg-slate-800/60', 'dark:bg-[#181818]'],
  ['dark:bg-slate-800/40', 'dark:bg-[#181818]'],
  ['dark:bg-slate-800', 'dark:bg-[#181818]'],

  // Borders.
  ['dark:border-[#1F2937]', 'dark:border-[#1F1F1F]'],
  ['dark:border-slate-800/70', 'dark:border-[#1F1F1F]/70'],
  ['dark:border-slate-800/80', 'dark:border-[#1F1F1F]/80'],
  ['dark:border-slate-800/60', 'dark:border-[#1F1F1F]/60'],
  ['dark:border-slate-800', 'dark:border-[#1F1F1F]'],
  ['dark:border-slate-700', 'dark:border-[#1F1F1F]'],
  ['dark:border-slate-600', 'dark:border-[#2A2A2A]'],

  // Dividers.
  ['dark:divide-slate-800', 'dark:divide-[#1F1F1F]'],
  ['dark:divide-slate-700', 'dark:divide-[#1F1F1F]'],

  // Text colours.
  ['dark:text-[#E5E7EB]', 'dark:text-[#FAFAFA]'],
  ['dark:text-slate-50', 'dark:text-[#FAFAFA]'],
  ['dark:text-slate-100', 'dark:text-[#FAFAFA]'],
  ['dark:text-slate-200', 'dark:text-[#FAFAFA]'],
  ['dark:text-slate-300', 'dark:text-[#A1A1AA]'],
  ['dark:text-slate-400', 'dark:text-[#A1A1AA]'],
  ['dark:text-slate-500', 'dark:text-[#71717A]'],

  // Rings.
  ['dark:ring-slate-900', 'dark:ring-black'],
  ['dark:ring-slate-800', 'dark:ring-[#1F1F1F]'],
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

let totalRewrites = 0;
for (const rel of FILES) {
  const path = join(process.cwd(), rel);
  const before = readFileSync(path, 'utf8');
  let after = before;
  let fileHits = 0;
  for (const [from, to] of SUBS) {
    const parts = after.split(from);
    if (parts.length > 1) {
      fileHits += parts.length - 1;
      after = parts.join(to);
    }
  }
  if (fileHits > 0) {
    writeFileSync(path, after, 'utf8');
    totalRewrites += fileHits;
    console.log(`${rel}: ${fileHits} substitutions`);
  }
}
console.log(`done. ${totalRewrites} total substitutions across ${FILES.length} files.`);
