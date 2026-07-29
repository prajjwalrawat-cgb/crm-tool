/**
 * Unit self-test for intent-deferred link prefetching. No DB.
 *   pnpm tsx scripts/selftest-prefetch.ts
 *
 * Guards a production-only performance property: automatic `<Link>`
 * prefetch runs ONLY in production, so a regression here is invisible in
 * `next dev` and shows up as a slow deployed app. The sidebar renders
 * 19-23 links on every dashboard page and the deals table one per row;
 * if those go back to a bare `<Link>`, every page load fans out that many
 * concurrent `?_rsc=` server renders against a 10-connection pool.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolvePrefetch } from '../src/app/dashboard/_components/hover-prefetch-link';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  results.push({ name, ok });
  if (!ok) exitCode = 1;
}

// `false` = no prefetch on viewport entry. `null` = Next's default.
check('no intent → false (not prefetched on viewport entry)', resolvePrefetch(undefined, false) === false);
check('intent shown → null (default prefetch restored)', resolvePrefetch(undefined, true) === null);
check('explicit false wins over intent', resolvePrefetch(false, true) === false);
check('explicit true wins over no intent', resolvePrefetch(true, false) === true);
check('explicit null wins', resolvePrefetch(null, false) === null);

// Source-level guard: the two high-fan-out surfaces must not fall back
// to a bare <Link> for their repeated links.
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

const sidebar = read('src', 'app', 'dashboard', '_components', 'sidebar.tsx');
check('sidebar nav items use HoverPrefetchLink', sidebar.includes('<HoverPrefetchLink'));
check(
  'sidebar nav items do not use bare <Link>',
  !/<Link\s+href=\{item\.href\}/.test(sidebar),
);

const dealsView = read('src', 'app', 'dashboard', 'deals', '_components', 'deals-view.tsx');
const rowLinks = dealsView.match(/<HoverPrefetchLink\s+href=\{`\/dashboard\/deals\/\$\{d\.id\}`\}/g) ?? [];
check('deals table row links use HoverPrefetchLink (both layouts)', rowLinks.length === 2);
check(
  'deals table has no bare <Link> to a deal row',
  !/<Link\s+href=\{`\/dashboard\/deals\/\$\{d\.id\}`\}/.test(dealsView),
);

console.log('\n─── Link prefetch unit self-test ───');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
process.exit(exitCode);
