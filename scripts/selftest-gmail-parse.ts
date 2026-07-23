/**
 * Unit self-test for the pure Gmail parsing helpers (Module 3). No DB / network.
 *   pnpm tsx scripts/selftest-gmail-parse.ts
 */
import {
  buildSnippet,
  counterpartyAddresses,
  determineDirection,
  domainOf,
  headerValue,
  parseAddressList,
} from '../src/lib/email/gmail/parse';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

// parseAddressList
{
  const a = parseAddressList('Ravi Joshi <ravi@anthropic.com>, "Doe, Jane" <jane@x.io>, bob@y.com');
  check('parses 3 addresses', a.length === 3, `n=${a.length}`);
  check('name + email', a[0]!.email === 'ravi@anthropic.com' && a[0]!.name === 'Ravi Joshi');
  check('quoted name with comma', a[1]!.name === 'Doe, Jane' && a[1]!.email === 'jane@x.io');
  check('bare email', a[2]!.email === 'bob@y.com' && a[2]!.name === null);
  check('lowercases email', parseAddressList('A <Ravi@Anthropic.COM>')[0]!.email === 'ravi@anthropic.com');
  check('empty → []', parseAddressList('').length === 0 && parseAddressList(null).length === 0);
}

// domainOf
check('domainOf', domainOf('a@b.com') === 'b.com' && domainOf('bad') === null);

// determineDirection
{
  const from = parseAddressList('Me <rep@cgbindia.com>');
  check('outbound when from is mailbox', determineDirection(from, 'rep@cgbindia.com') === 'outbound');
  check('inbound otherwise', determineDirection(parseAddressList('c@x.com'), 'rep@cgbindia.com') === 'inbound');
}

// counterpartyAddresses
{
  const msg = {
    from: parseAddressList('client@acme.com'),
    to: parseAddressList('rep@cgbindia.com, colleague@cgbindia.com'),
    cc: parseAddressList('assistant@acme.com, noreply@calendar.google.com'),
  };
  const cps = counterpartyAddresses(msg, {
    mailboxEmail: 'rep@cgbindia.com',
    excludedDomains: ['cgbindia.com', 'calendar.google.com'],
    excludedAddresses: [],
  });
  check('excludes own domain + excluded domain, keeps counterparties',
    cps.length === 2 && cps.includes('client@acme.com') && cps.includes('assistant@acme.com'),
    cps.join(','));
  check('excludes explicit address',
    !counterpartyAddresses(msg, { mailboxEmail: 'rep@cgbindia.com', excludedDomains: [], excludedAddresses: ['client@acme.com'] }).includes('client@acme.com'));
  // Dedup
  const dupMsg = { from: parseAddressList('x@a.com'), to: parseAddressList('x@a.com'), cc: [] };
  check('dedups', counterpartyAddresses(dupMsg, { mailboxEmail: 'me@z.com', excludedDomains: [], excludedAddresses: [] }).length === 1);
}

// buildSnippet
{
  const body = 'Hi Priya,\n\nSounds good — let us proceed.\n\nOn Mon, Jul 1, 2026 at 9:00 AM Priya wrote:\n> earlier quoted text\n> more quoted';
  const snip = buildSnippet(body);
  check('strips quoted reply', snip === 'Hi Priya, Sounds good — let us proceed.', snip);
  check('empty body → ""', buildSnippet('') === '' && buildSnippet(null) === '');
  const long = 'x'.repeat(500);
  const capped = buildSnippet(long);
  check('caps at 200 with ellipsis', capped.length === 200 && capped.endsWith('…'), `len=${capped.length}`);
}

// headerValue
{
  const headers = [{ name: 'Subject', value: 'Hello' }, { name: 'From', value: 'a@b.com' }];
  check('headerValue case-insensitive', headerValue(headers, 'subject') === 'Hello' && headerValue(headers, 'FROM') === 'a@b.com');
  check('missing header → null', headerValue(headers, 'Cc') === null);
}

console.log('\n─── Gmail parse unit self-test ───');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
process.exit(exitCode);
