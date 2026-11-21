/**
 * Unit self-test for Module 5 name/email normalizers. Pure, no DB.
 *   pnpm tsx scripts/selftest-dedup-normalize.ts
 */
import {
  companyNameCore,
  GENERIC_COMPANY_WORDS_PG_RE,
  normalizeCompanyName,
  normalizeContactName,
  normalizeEmail,
} from '../src/lib/dedup/normalize';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function eq(name: string, got: string, want: string): void {
  const ok = got === want;
  results.push({ name, ok, detail: ok ? undefined : `got "${got}" want "${want}"` });
  if (!ok) exitCode = 1;
}

eq('spec example (Godawari)', normalizeCompanyName('Godawari Power and Ispat Ltd (GPIL)'), 'godawari power and ispat gpil');
eq('strips Ltd', normalizeCompanyName('Acme Ltd'), 'acme');
eq('strips Limited', normalizeCompanyName('Acme Limited'), 'acme');
eq('strips Pvt Ltd', normalizeCompanyName('Acme Pvt Ltd'), 'acme');
eq('strips Inc + punctuation', normalizeCompanyName('  Foo,  Bar  Inc. '), 'foo bar');
eq('all-suffix falls back', normalizeCompanyName('Ltd'), 'ltd');
eq('strips diacritics', normalizeCompanyName('Café Ltd'), 'cafe');
eq('LLP', normalizeCompanyName('Baker & Co LLP'), 'baker');
eq('empty', normalizeCompanyName('   '), '');

eq('email lowercased/trimmed', normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
eq('email null', normalizeEmail(null), '');

eq('contact name', normalizeContactName('John', 'Doe'), 'john doe');
eq('contact name punctuation', normalizeContactName("O'Brien", 'Smith'), 'o brien smith');

// Fuzzy matching compares only the distinctive part (AskMiraa's "L&T Technology"
// was offered Speridian Technology, Yash Technologies and Dixon Technologies).
eq('core drops generic word', companyNameCore(normalizeCompanyName('L&T Technology')), 'l t');
eq('core keeps the name', companyNameCore(normalizeCompanyName('Yash Technologies Pvt Ltd')), 'yash');
eq('core of all-generic is empty', companyNameCore(normalizeCompanyName('Technology Solutions')), '');
eq('core keeps Godawari', companyNameCore(normalizeCompanyName('Godawari Power and Ispat Ltd')), 'godawari power ispat');
eq('core whole tokens only', companyNameCore('techmahindra it'), 'techmahindra');
eq('pg regex has word bounds', GENERIC_COMPANY_WORDS_PG_RE.slice(0, 5), '\\m(?:');

console.log('\n─── Dedup normalize unit self-test ───');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
process.exit(exitCode);
