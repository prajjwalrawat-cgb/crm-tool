/**
 * Pure self-test for lead capture (build prompt 1): phone/email normalization,
 * field mapping, webhook auth, idempotency keys, rule conditions, every
 * distribution strategy, working-hours eligibility and SLA extension across
 * non-working time. No database. Expected values are written out by hand.
 *
 *   tsx scripts/selftest-lead-capture.ts
 */
import { ruleMatches, evaluateCondition } from '../src/lib/lead-capture/conditions';
import { applyFieldMapping, leadDisplayName, validateMappedLead } from '../src/lib/lead-capture/mapping';
import { cleanText, normalizeEmail, normalizePhone } from '../src/lib/lead-capture/normalize';
import { canonicalJson, ingestIdempotencyKey, signBody, verifyIngestAuth } from '../src/lib/lead-capture/signature';
import {
  pickRoundRobin,
  pickSmoothWeighted,
  runStrategy,
  type Candidate,
} from '../src/lib/lead-capture/strategies';
import {
  addWorkingMinutes,
  isWithinWorkingHours,
  nextWorkingStart,
  validateWorkingHours,
} from '../src/lib/lead-capture/working-hours';
import type { WorkingHours } from '../src/db/schema/lead-capture';
import { parseCsv } from '../src/lib/lead-capture/csv';
import { suggestMappingHeuristic } from '../src/lib/lead-capture/mapping';
import { canonicalRow, previewRows } from '../src/lib/lead-capture/import-rows';
import { checkSubmission, corsOrigin } from '../src/lib/lead-capture/form-submission';
import { LEAD_FIELD_KEYS as CLIENT_KEYS } from '../src/lib/lead-capture/constants';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// ---------------------------------------------------------------- phones
const E164 = '+919876543210';
for (const raw of [
  '+91 98765 43210',
  '+91-98765-43210',
  '098765 43210',
  '09876543210',
  '9876543210',
  '98765 43210',
  '91 98765 43210',
  '919876543210',
  '0091 98765 43210',
  '(+91) 98765-43210',
  ' 9876543210 ',
  9876543210,
]) {
  eq(`phone ${JSON.stringify(raw)}`, normalizePhone(raw), E164);
}
eq('phone landline with STD 0', normalizePhone('022 2345 6789'), '+912223456789');
eq('phone foreign +1', normalizePhone('+1 (415) 555-2671'), '+14155552671');
eq('phone too short', normalizePhone('12345'), null);
eq('phone garbage', normalizePhone('call me'), null);
eq('phone empty', normalizePhone(''), null);
eq('phone null', normalizePhone(null), null);
// min metadata validates by length only, so a 10-digit IN number is always accepted; consistency is what dedupe needs.
eq('phone same 10 digits same key', normalizePhone('1234567890') === normalizePhone('+91 12345 67890'), true);

// ---------------------------------------------------------------- email / text
eq('email lower+trim', normalizeEmail('  Ravi.K@Example.CO.IN '), 'ravi.k@example.co.in');
eq('email invalid', normalizeEmail('ravi at example'), null);
eq('strip html', cleanText('<b>Hello</b> <script>alert(1)</script>world'), 'Hello world');
eq('strip control chars', cleanText('a\u0000b\u0007c'), 'abc');

// ---------------------------------------------------------------- mapping
{
  const m = applyFieldMapping({
    SENDER_NAME: 'Ravi Kumar',
    SENDER_MOBILE: '+91-9876543210',
    SENDER_EMAIL: 'RAVI@acme.in',
    SENDER_COMPANY: 'Acme Castings Pvt Ltd',
    SENDER_CITY: 'Pune',
    SENDER_STATE: 'Maharashtra',
    QUERY_PRODUCT_NAME: 'Induction Furnace',
    QUERY_MESSAGE: 'Need 2 ton <i>urgent</i>',
  });
  eq('alias first name', m.firstName, 'Ravi');
  eq('alias last name', m.lastName, 'Kumar');
  eq('alias phone normalized', m.phoneNormalized, E164);
  eq('alias email normalized', m.emailNormalized, 'ravi@acme.in');
  eq('alias company', m.company, 'Acme Castings Pvt Ltd');
  eq('alias city/state', [m.city, m.state], ['Pune', 'Maharashtra']);
  eq('alias product', m.productInterest, 'Induction Furnace');
  eq('message html stripped', m.message, 'Need 2 ton urgent');
  eq('display name', leadDisplayName(m), 'Acme Castings Pvt Ltd – Induction Furnace');
  eq('valid', validateMappedLead(m), null);
}
{
  const m = applyFieldMapping(
    { cust_mob: '09876543210', budget: '5 lakh', plant: 'Nagpur', name: 'ignored-alias?' },
    { cust_mob: 'phone', budget: 'custom.budget', plant: 'city' },
  );
  eq('explicit mapping phone', m.phoneNormalized, E164);
  eq('explicit mapping custom', m.custom, { budget: '5 lakh' });
  eq('explicit mapping city', m.city, 'Nagpur');
  eq('alias still fills unmapped', m.firstName, 'ignored-alias?');
}
{
  const m = applyFieldMapping({
    field_data: [
      { name: 'email', values: ['meta@lead.com'] },
      { name: 'phone_number', values: ['+919876543210'] },
      { name: 'full_name', values: ['Asha Rao'] },
    ],
  });
  eq('meta field_data email', m.emailNormalized, 'meta@lead.com');
  eq('meta field_data phone', m.phoneNormalized, E164);
  eq('meta field_data name', [m.firstName, m.lastName], ['Asha', 'Rao']);
}
eq('nested payload', applyFieldMapping({ lead: { email: 'x@y.io' } }).emailNormalized, 'x@y.io');
eq('consent yes', applyFieldMapping({ email: 'a@b.co', consent: 'yes' }).consent, true);
eq('consent missing', applyFieldMapping({ email: 'a@b.co' }).consent, null);
eq('needs phone or email', validateMappedLead(applyFieldMapping({ name: 'x' })), 'need at least a phone or an email');
eq('both invalid', validateMappedLead(applyFieldMapping({ phone: '123', email: 'nope' })), 'phone and email are both invalid');

// ---------------------------------------------------------------- auth + idempotency
{
  const secret = 'a'.repeat(64);
  const body = '{"email":"a@b.co"}';
  const sig = signBody(body, secret);
  check('hmac ok', verifyIngestAuth({ rawBody: body, secret, tokenHeader: null, signatureHeader: sig }));
  check('hmac ok with prefix', verifyIngestAuth({ rawBody: body, secret, tokenHeader: null, signatureHeader: `sha256=${sig}` }));
  check('hmac tampered body', !verifyIngestAuth({ rawBody: body + ' ', secret, tokenHeader: null, signatureHeader: sig }));
  check('hmac malformed', !verifyIngestAuth({ rawBody: body, secret, tokenHeader: null, signatureHeader: 'zzz' }));
  check('hmac wins over a correct token', !verifyIngestAuth({ rawBody: body, secret, tokenHeader: secret, signatureHeader: 'f'.repeat(64) }));
  check('token ok', verifyIngestAuth({ rawBody: body, secret, tokenHeader: secret, signatureHeader: null }));
  check('token wrong', !verifyIngestAuth({ rawBody: body, secret, tokenHeader: 'b'.repeat(64), signatureHeader: null }));
  check('token short', !verifyIngestAuth({ rawBody: body, secret, tokenHeader: 'x', signatureHeader: null }));
  check('no auth', !verifyIngestAuth({ rawBody: body, secret, tokenHeader: null, signatureHeader: null }));

  eq('canonical json sorts keys', canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  eq(
    'idempotency key ignores key order',
    ingestIdempotencyKey('s1', { a: 1, b: 2 }) === ingestIdempotencyKey('s1', { b: 2, a: 1 }),
    true,
  );
  eq('idempotency key differs by source', ingestIdempotencyKey('s1', { a: 1 }) === ingestIdempotencyKey('s2', { a: 1 }), false);
}

// ---------------------------------------------------------------- conditions
{
  const facts = { state: 'Maharashtra', city: 'Pune', source_type: 'portal', budget: '500000', 'custom.size': 'large', company: null };
  check('eq case-insensitive', evaluateCondition({ field: 'state', op: 'eq', value: 'maharashtra' }, facts));
  check('neq', evaluateCondition({ field: 'state', op: 'neq', value: 'Gujarat' }, facts));
  check('in array', evaluateCondition({ field: 'city', op: 'in', value: ['Mumbai', 'pune'] }, facts));
  check('in csv', evaluateCondition({ field: 'city', op: 'in', value: 'Mumbai, Pune' }, facts));
  check('contains', evaluateCondition({ field: 'state', op: 'contains', value: 'rash' }, facts));
  check('gt numeric string', evaluateCondition({ field: 'budget', op: 'gt', value: 100000 }, facts));
  check('lt false', !evaluateCondition({ field: 'budget', op: 'lt', value: 100000 }, facts));
  check('gt non-numeric false', !evaluateCondition({ field: 'city', op: 'gt', value: 1 }, facts));
  check('exists', evaluateCondition({ field: 'custom.size', op: 'exists' }, facts));
  check('exists false on null', !evaluateCondition({ field: 'company', op: 'exists' }, facts));
  check('missing via exists=false', evaluateCondition({ field: 'company', op: 'exists', value: false }, facts));
  check('eq on missing field false', !evaluateCondition({ field: 'nope', op: 'eq', value: '' }, facts));
  check('all must match', !ruleMatches([{ field: 'state', op: 'eq', value: 'Maharashtra' }, { field: 'city', op: 'eq', value: 'Nagpur' }], facts));
  check('empty conditions match', ruleMatches([], facts));
}

// ---------------------------------------------------------------- strategies
{
  const pool = ['u1', 'u2', 'u3'];
  eq('rr first', pickRoundRobin(pool, new Set(pool), null), 'u1');
  eq('rr after u1', pickRoundRobin(pool, new Set(pool), 'u1'), 'u2');
  eq('rr wraps', pickRoundRobin(pool, new Set(pool), 'u3'), 'u1');
  eq('rr skips ineligible', pickRoundRobin(pool, new Set(['u1', 'u3']), 'u1'), 'u3');
  eq('rr last user removed from pool', pickRoundRobin(pool, new Set(pool), 'gone'), 'u1');
  eq('rr none eligible', pickRoundRobin(pool, new Set(), 'u1'), null);

  // 300 picks over 3 users: exactly 100 each.
  let last: string | null = null;
  const counts: Record<string, number> = {};
  for (let i = 0; i < 300; i++) {
    last = pickRoundRobin(pool, new Set(pool), last);
    counts[last!] = (counts[last!] ?? 0) + 1;
  }
  eq('rr balanced', counts, { u1: 100, u2: 100, u3: 100 });

  // nginx smooth weighted: weights a=5,b=1,c=1 → a a b a c a a
  let state: Record<string, number> = {};
  const seq: string[] = [];
  for (let i = 0; i < 7; i++) {
    const r = pickSmoothWeighted(['a', 'b', 'c'], { a: 5, b: 1, c: 1 }, state);
    seq.push(r.userId!);
    state = r.state;
  }
  eq('smooth weighted sequence', seq.join(''), 'aabacaa');
  eq('weighted all zero', pickSmoothWeighted(['a'], { a: 0 }, {}).userId, null);

  const cands: Candidate[] = [
    { userId: 'u1', load: 4, skills: ['furnace'], regions: ['Pune'] },
    { userId: 'u2', load: 1, skills: ['Furnace', 'crane'], regions: ['Gujarat'] },
    { userId: 'u3', load: 1, skills: ['crane'], regions: ['maharashtra'] },
  ];
  const base = { poolOrder: pool, eligible: cands, lastUserId: null, lead: { productInterest: 'Induction Furnace', city: 'Pune', state: 'Maharashtra' } };
  eq('least loaded tie → pool order', runStrategy({ ...base, strategy: 'least_loaded' }).userId, 'u2');
  eq('skill match least loaded', runStrategy({ ...base, strategy: 'skill_match' }).userId, 'u2');
  eq('skill no match', runStrategy({ ...base, strategy: 'skill_match', lead: { ...base.lead, productInterest: 'boiler' } }).userId, null);
  eq('geo match (state) beats loaded city match', runStrategy({ ...base, strategy: 'geo_match' }).userId, 'u3');
  eq('geo no place', runStrategy({ ...base, strategy: 'geo_match', lead: { productInterest: null, city: null, state: null } }).userId, null);
  eq('fixed owner', runStrategy({ ...base, strategy: 'fixed_owner', fixedOwnerId: 'u3' }).userId, 'u3');
  eq('fixed owner ineligible', runStrategy({ ...base, strategy: 'fixed_owner', fixedOwnerId: 'u9' }).userId, null);
  eq('no eligible', runStrategy({ ...base, strategy: 'round_robin', eligible: [] }).userId, null);
  eq('rr via runStrategy advances pointer', runStrategy({ ...base, strategy: 'round_robin', lastUserId: 'u2' }).nextLastUserId, 'u3');
}

// ---------------------------------------------------------------- working hours (IST, UTC+5:30)
{
  const wh: WorkingHours = {
    tz: 'Asia/Kolkata',
    days: { mon: ['09:30', '18:30'], tue: ['09:30', '18:30'], wed: ['09:30', '18:30'], thu: ['09:30', '18:30'], fri: ['09:30', '18:30'], sat: ['10:00', '14:00'] },
  };
  eq('valid wh', validateWorkingHours(wh), null);
  eq('bad tz', validateWorkingHours({ tz: 'Mars/Base', days: {} }), 'unknown timezone: Mars/Base');
  eq('end before start', validateWorkingHours({ tz: 'UTC', days: { mon: ['18:00', '09:00'] } }), 'mon: end must be after start');

  // 2026-11-16 is a Monday. 10:00 IST = 04:30Z.
  check('inside mon 10:00 IST', isWithinWorkingHours(wh, new Date('2026-11-16T04:30:00Z')));
  check('before start 09:29 IST', !isWithinWorkingHours(wh, new Date('2026-11-16T03:59:00Z')));
  check('at start 09:30 IST', isWithinWorkingHours(wh, new Date('2026-11-16T04:00:00Z')));
  check('at end 18:30 IST is out', !isWithinWorkingHours(wh, new Date('2026-11-16T13:00:00Z')));
  check('sunday out', !isWithinWorkingHours(wh, new Date('2026-11-15T06:00:00Z')));
  check('null wh always in', isWithinWorkingHours(null, new Date('2026-11-15T21:00:00Z')));

  eq('next start from sunday → mon 09:30 IST', nextWorkingStart(wh, new Date('2026-11-15T06:00:00Z'))?.toISOString(), '2026-11-16T04:00:00.000Z');
  eq('next start inside window = now', nextWorkingStart(wh, new Date('2026-11-16T05:00:00Z'))?.toISOString(), '2026-11-16T05:00:00.000Z');

  // Plain: 10:00 + 30m = 10:30 IST (05:00Z).
  eq('sla inside window', addWorkingMinutes(new Date('2026-11-16T04:30:00Z'), 30, wh).toISOString(), '2026-11-16T05:00:00.000Z');
  // 18:15 IST mon + 30m → 15m left today, 15m from tue 09:30 → tue 09:45 IST (04:15Z).
  eq('sla carries overnight', addWorkingMinutes(new Date('2026-11-16T12:45:00Z'), 30, wh).toISOString(), '2026-11-17T04:15:00.000Z');
  // Fri 18:00 IST + 60m → 30m fri, 30m sat from 10:00 → sat 10:30 IST (05:00Z).
  eq('sla fri→sat', addWorkingMinutes(new Date('2026-11-20T12:30:00Z'), 60, wh).toISOString(), '2026-11-21T05:00:00.000Z');
  // Sat 13:30 IST + 60m → 30m sat, (sun off), 30m mon → mon 10:00 IST (04:30Z).
  eq('sla skips sunday', addWorkingMinutes(new Date('2026-11-21T08:00:00Z'), 60, wh).toISOString(), '2026-11-23T04:30:00.000Z');
  // Assigned sunday night → starts mon 09:30, due 10:00.
  eq('sla from off day', addWorkingMinutes(new Date('2026-11-15T17:00:00Z'), 30, wh).toISOString(), '2026-11-16T04:30:00.000Z');
  eq('sla 24/7', addWorkingMinutes(new Date('2026-11-15T17:00:00Z'), 30, null).toISOString(), '2026-11-15T17:30:00.000Z');
  eq('sla no working days falls back', addWorkingMinutes(new Date('2026-11-15T17:00:00Z'), 30, { tz: 'UTC', days: {} }).toISOString(), '2026-11-15T17:30:00.000Z');

  // DST zone sanity: New York 09:00-17:00, 2026-03-09 (Mon, after DST began 03-08) 09:00 EDT = 13:00Z.
  const ny: WorkingHours = { tz: 'America/New_York', days: { mon: ['09:00', '17:00'] } };
  eq('dst next start', nextWorkingStart(ny, new Date('2026-03-08T12:00:00Z'))?.toISOString(), '2026-03-09T13:00:00.000Z');
}

// ---------------------------------------------------------------- CSV parse
{
  const csv = '﻿Name,Mobile No,"Company, Ltd",Notes\r\n"Ravi ""RK"" Kumar",098765 43210,"Acme, Pune","line1\nline2"\r\n\r\nAsha,9811122233,,\n';
  const p = parseCsv(csv);
  eq('csv headers (BOM stripped, quoted comma)', p.headers, ['Name', 'Mobile No', 'Company, Ltd', 'Notes']);
  eq('csv row count skips blank lines', p.rows.length, 2);
  eq('csv escaped quote', p.rows[0]!['Name'], 'Ravi "RK" Kumar');
  eq('csv quoted newline kept', p.rows[0]!['Notes'], 'line1\nline2');
  eq('csv semicolon delimiter', parseCsv('a;b\n1;2').rows[0], { a: '1', b: '2' });
  eq('csv duplicate headers renamed', parseCsv('Phone,Phone\n1,2').headers, ['Phone', 'Phone_2']);
  eq('csv empty', parseCsv('').headers, []);
  eq('csv row cap', parseCsv('a\n1\n2\n3\n4', 2).rows.length, 2);
}

// ---------------------------------------------------------------- heuristic header mapping
{
  const m = suggestMappingHeuristic(['SENDER_NAME', 'Customer Mobile No', 'E-mail', 'Company Name', 'City', 'QUERY_PRODUCT_NAME', 'Remarks', 'Lead Score']);
  eq('heuristic exact alias', m['SENDER_NAME'], 'full_name');
  eq('heuristic contains match', m['Customer Mobile No'], 'phone');
  eq('heuristic dash canon', m['E-mail'], 'email');
  eq('heuristic company', m['Company Name'], 'company');
  eq('heuristic product', m['QUERY_PRODUCT_NAME'], 'product_interest');
  eq('heuristic unknown → null', m['Lead Score'], null);
  const dup = suggestMappingHeuristic(['Mobile', 'Phone']);
  eq('heuristic one header per field', Object.values(dup).filter((v) => v === 'phone').length, 1);
  eq('client constants match server keys', CLIENT_KEYS.length >= 19 && CLIENT_KEYS.includes('phone'), true);
}

// ---------------------------------------------------------------- import rows
{
  const mapping = { 'Mobile No': 'phone' as const, Name: 'full_name' as const, Junk: null };
  eq('canonical row keeps only mapped', canonicalRow({ 'Mobile No': '9876543210', Name: 'Ravi', Junk: 'x' }, mapping), { phone: '9876543210', full_name: 'Ravi' });
  const pr = previewRows([{ 'Mobile No': '9876543210', Name: 'Ravi' }, { 'Mobile No': '', Name: 'Nobody' }], mapping);
  eq('preview row ok', pr[0]!.error, null);
  eq('preview row error', pr[1]!.error, 'need at least a phone or an email');
}

// ---------------------------------------------------------------- forms: CORS + submission
{
  const app = 'https://crm.example.com';
  eq('cors same origin', corsOrigin(app, app, []), app);
  eq('cors allowed embed', corsOrigin('https://www.acme.in', app, ['https://www.acme.in']), 'https://www.acme.in');
  eq('cors refused', corsOrigin('https://evil.test', app, ['https://www.acme.in']), null);
  eq('cors no origin header', corsOrigin(null, app, []), null);

  const form = {
    formId: 'f1',
    consentText: 'I agree',
    fields: [
      { key: 'name', label: 'Name', type: 'text' as const, required: true },
      { key: 'email', label: 'Email', type: 'email' as const },
      { key: 'product', label: 'Product', type: 'select' as const, options: ['Furnace', 'Crane'] },
    ],
  };
  const now = 1_000_000;
  const base = { fields: { name: 'Ravi', email: 'ravi@acme.in', product: 'Furnace' }, consent: true, t: now - 10_000 };
  const ok = checkSubmission(form, base, now);
  check('form ok', ok.kind === 'ok');
  if (ok.kind === 'ok') eq('form payload', ok.payload, { name: 'Ravi', email: 'ravi@acme.in', product: 'Furnace', consent: true, form_id: 'f1' });
  eq('honeypot silently dropped', checkSubmission(form, { ...base, hp: 'http://spam' }, now).kind, 'silent_drop');
  eq('too fast silently dropped', checkSubmission(form, { ...base, t: now - 500 }, now).kind, 'silent_drop');
  eq('consent required', checkSubmission(form, { ...base, consent: false }, now).kind, 'invalid');
  eq('required field', checkSubmission(form, { ...base, fields: { ...base.fields, name: ' ' } }, now).kind, 'invalid');
  eq('bad email', checkSubmission(form, { ...base, fields: { ...base.fields, email: 'nope' } }, now).kind, 'invalid');
  eq('bad select option', checkSubmission(form, { ...base, fields: { ...base.fields, product: 'Boiler' } }, now).kind, 'invalid');
  const withUtm = checkSubmission(form, { ...base, utm: { source: 'google', campaign: 'q4' }, landingUrl: 'https://acme.in/?x', referrer: 'https://google.com' }, now);
  if (withUtm.kind === 'ok') eq('utm + urls carried', [withUtm.payload.utm_source, withUtm.payload.utm_campaign, withUtm.payload.landing_url, withUtm.payload.referrer_url], ['google', 'q4', 'https://acme.in/?x', 'https://google.com']);
  const noConsentForm = { ...form, consentText: null };
  eq('no consent text → no consent needed', checkSubmission(noConsentForm, { ...base, consent: undefined }, now).kind, 'ok');
}

console.log(`lead-capture selftest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
