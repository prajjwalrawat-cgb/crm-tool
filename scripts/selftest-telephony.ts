/**
 * Pure self-test for telephony (build prompt 2). No database, no network.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-telephony.ts
 *
 * Covers: Exotel webhook normalization fixtures for each status (StatusCallback
 * JSON, form-encoded lower-case keys, Passthru inbound), status never regresses,
 * duplicate + out-of-order webhooks converge, credential encryption round trip
 * and tamper detection, webhook secret / IP checks, calling hours, DNC upload
 * parsing, AI summary validation on 3 golden transcripts, the invalid-JSON
 * retry path, follow-up date grounding, and that a serialized call never
 * carries the provider recording URL or the storage key.
 */
import type Anthropic from '@anthropic-ai/sdk';

import type { CallRow, CallStatus } from '../src/db/schema/telephony';
import { buildCallSummaryUserMessage, groundFollowUpDate, parseCallSummary } from '../src/lib/telephony/ai-summary';
import { summarizeCallTranscript } from '../src/lib/telephony/ai-summary-claude';
import { isWithinCallingHours, validateCallingHours } from '../src/lib/telephony/calling-hours';
import { decryptJson, encryptJson, loadKmsKey, MissingKmsKeyError } from '../src/lib/telephony/crypto';
import { parseDncUpload } from '../src/lib/telephony/dnc-parse';
import { exotelProvider, parseExotelTime, parseExotelWebhook } from '../src/lib/telephony/providers/exotel';
import { serializeCall } from '../src/lib/telephony/serialize';
import { isTerminal, mergeStatus } from '../src/lib/telephony/status';
import type { TelephonyAccountContext } from '../src/lib/telephony/types';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}
const eq = (name: string, a: unknown, b: unknown) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

async function main() {
  // ------------------------------------------------------------ Exotel fixtures
  const base = {
    CallSid: '80bfbec2d78bbbf10fb851f4fa165211',
    DateCreated: '2026-11-16 10:00:00',
    From: '+919876500001',
    To: '+919811122233',
    PhoneNumberSid: '08047181234',
    Direction: 'outbound-api',
    CustomField: '0f8fad5b-d9cb-469f-a165-70867728950e',
  };
  const terminal = {
    ...base,
    EventType: 'terminal',
    Status: 'completed',
    DateUpdated: '2026-11-16 10:05:30',
    StartTime: '2026-11-16 10:00:05',
    EndTime: '2026-11-16 10:05:25',
    ConversationDuration: 320,
    RecordingUrl: 'https://s3-ap-southeast-1.amazonaws.com/exotelrecordings/acct/80bf.mp3',
    Legs: [
      { OnCallDuration: 330, Status: 'completed' },
      { OnCallDuration: 320, Status: 'completed' },
    ],
  };
  const t = parseExotelWebhook(terminal)!;
  eq('terminal → completed', t.status, 'completed');
  eq('terminal talk time from ConversationDuration', t.talkTimeSec, 320);
  eq('terminal direction outbound', t.direction, 'outbound');
  eq('terminal customData', t.customData, base.CustomField);
  eq('terminal recording url kept', t.recordingUrl, terminal.RecordingUrl);
  eq('IST timestamp parsed', t.startedAt?.toISOString(), '2026-11-16T04:30:05.000Z');
  eq('duration from start/end when absent', t.durationSec, 320);

  eq('answered event', parseExotelWebhook({ ...base, EventType: 'answered', Status: 'in-progress', DateUpdated: '2026-11-16 10:00:20' })?.status, 'answered');
  eq('no-answer', parseExotelWebhook({ ...base, EventType: 'terminal', Status: 'no-answer' })?.status, 'no_answer');
  eq('busy', parseExotelWebhook({ ...base, EventType: 'terminal', Status: 'busy' })?.status, 'busy');
  eq('failed', parseExotelWebhook({ ...base, EventType: 'terminal', Status: 'failed' })?.status, 'failed');
  eq('completed with 0 talk = no_answer', parseExotelWebhook({ ...base, Status: 'completed', ConversationDuration: 0 })?.status, 'no_answer');
  eq('talk time from second leg when no ConversationDuration', parseExotelWebhook({ ...base, Status: 'completed', Legs: [{ OnCallDuration: 40, Status: 'completed' }, { OnCallDuration: 33, Status: 'completed' }] })?.talkTimeSec, 33);
  eq('queued → initiated', parseExotelWebhook({ ...base, Status: 'queued' })?.status, 'initiated');
  eq('form-encoded lower-case keys', parseExotelWebhook({ callsid: 'abc', status: 'busy', from: '0981', to: '0982' })?.status, 'busy');
  eq('missing CallSid → null', parseExotelWebhook({ Status: 'completed' }), null);
  eq('unknown status on outbound → null', parseExotelWebhook({ CallSid: 'x', Status: 'weird', Direction: 'outbound-api' }), null);
  eq('non-object → null', parseExotelWebhook('nope'), null);
  eq('"null" strings tolerated', parseExotelWebhook({ ...base, Status: 'completed', RecordingUrl: 'null', ConversationDuration: 12 })?.recordingUrl, null);

  const passthru = parseExotelWebhook({ CallSid: 'in-1', CallFrom: '09811122233', CallTo: '08047181234', Direction: 'incoming', DialWhomNumber: '09876500001' })!;
  eq('passthru inbound', [passthru.direction, passthru.status, passthru.from, passthru.agentPhone], ['inbound', 'ringing', '09811122233', '09876500001']);
  eq('passthru missed (client-hangup)', parseExotelWebhook({ CallSid: 'in-2', CallFrom: '0981', Direction: 'incoming', DialCallStatus: 'client-hangup' })?.status, 'missed');
  eq('passthru dial completed', parseExotelWebhook({ CallSid: 'in-3', CallFrom: '0981', Direction: 'incoming', DialCallStatus: 'completed' })?.status, 'completed');
  eq('ISO time with zone', parseExotelTime('2026-11-16T10:00:00Z')?.toISOString(), '2026-11-16T10:00:00.000Z');

  // ------------------------------------------------------------ status ordering
  eq('initiated → ringing', mergeStatus('initiated', 'ringing'), 'ringing');
  eq('answered does not go back to ringing', mergeStatus('answered', 'ringing'), 'answered');
  eq('terminal never regresses', mergeStatus('completed', 'answered'), 'completed');
  eq('terminal never flips to another terminal', mergeStatus('no_answer', 'completed'), 'no_answer');
  eq('null → incoming', mergeStatus(null, 'busy'), 'busy');
  check('isTerminal', isTerminal('missed') && !isTerminal('answered'));

  // Apply a webhook sequence in every order: one final status.
  const seq: CallStatus[] = ['ringing', 'answered', 'completed', 'completed'];
  const perms = (xs: CallStatus[]): CallStatus[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  const finals = new Set(perms(seq).map((p) => p.reduce<CallStatus | null>((cur, s) => mergeStatus(cur, s), 'initiated')));
  eq('out-of-order + duplicate webhooks converge', [...finals], ['completed']);

  // ------------------------------------------------------------ crypto
  const key = loadKmsKey('a'.repeat(64));
  const blob = encryptJson({ accountSid: 'sid', apiKey: 'k', apiToken: 't0p-secret' }, key);
  eq('round trip', decryptJson(blob, key), { accountSid: 'sid', apiKey: 'k', apiToken: 't0p-secret' });
  check('ciphertext does not contain the token', !blob.toString('latin1').includes('t0p-secret'));
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0x01;
  let tamperFailed = false;
  try {
    decryptJson(tampered, key);
  } catch {
    tamperFailed = true;
  }
  check('tampered ciphertext rejected (GCM tag)', tamperFailed);
  let wrongKeyFailed = false;
  try {
    decryptJson(blob, loadKmsKey('b'.repeat(64)));
  } catch {
    wrongKeyFailed = true;
  }
  check('wrong key rejected', wrongKeyFailed);
  let missing = false;
  try {
    loadKmsKey('');
  } catch (e) {
    missing = e instanceof MissingKmsKeyError;
  }
  check('missing KMS_KEY fails clearly', missing);
  check('base64 key accepted', loadKmsKey(Buffer.alloc(32, 7).toString('base64')).length === 32);

  // ------------------------------------------------------------ webhook verification
  const acct: TelephonyAccountContext = { id: 'a1', tenantId: 't1', provider: 'exotel', credentials: {}, virtualNumbers: [], webhookSecret: 'sekret-123' };
  const req = (url: string, ip: string | null = '1.2.3.4') => ({ url, method: 'POST', headers: new Headers(), rawBody: '', ip });
  check('secret in URL verifies', exotelProvider.verifyWebhook(req('https://x/api/public/telephony/exotel/a1/webhook?s=sekret-123'), acct));
  check('wrong secret rejected', !exotelProvider.verifyWebhook(req('https://x/w?s=sekret-124'), acct));
  check('no secret rejected', !exotelProvider.verifyWebhook(req('https://x/w'), acct));
  process.env.EXOTEL_WEBHOOK_IPS = '9.9.9.9';
  check('IP allowlist blocks other IPs', !exotelProvider.verifyWebhook(req('https://x/w?s=sekret-123'), acct));
  check('IP allowlist admits listed IP', exotelProvider.verifyWebhook(req('https://x/w?s=sekret-123', '9.9.9.9'), acct));
  delete process.env.EXOTEL_WEBHOOK_IPS;

  // ------------------------------------------------------------ Exotel connect response formats
  {
    const realFetch = globalThis.fetch;
    const live: TelephonyAccountContext = { ...acct, credentials: { accountSid: 'sid1', apiKey: 'k', apiToken: 't', subdomain: 'api.exotel.com' } };
    const dial = async (status: number, body: string, contentType: string) => {
      globalThis.fetch = (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as typeof fetch;
      try {
        return await exotelProvider.clickToCall({ account: live, agentPhone: '+919800000001', customerPhone: '+919811122233', callerId: '+911140847509', record: true, statusCallbackUrl: 'https://x/w?s=1', customData: { callId: 'c-123', tenantId: 't1' } });
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    const fromJson = await dial(200, JSON.stringify({ Call: { Sid: 'sid-json' } }), 'application/json');
    check('connect: Sid read from JSON', fromJson.providerCallId === 'sid-json');
    const fromXml = await dial(200, '<?xml version="1.0"?><TwilioResponse><Call><Sid>sid-xml</Sid><Status>in-progress</Status></Call></TwilioResponse>', 'application/xml');
    check('connect: Sid read from XML', fromXml.providerCallId === 'sid-xml');
    const unreadable = await dial(200, 'OK', 'text/plain');
    check('connect: 2xx without a Sid keeps the call pending (not failed)', unreadable.providerCallId === 'pending:c-123');
    let err403 = '';
    try {
      await dial(403, '<TwilioResponse><RestException><Status>403</Status><Message>Number not whitelisted for trial</Message></RestException></TwilioResponse>', 'application/xml');
    } catch (e) {
      err403 = (e as Error).message;
    }
    check("connect: 403 shows Exotel's own reason", /HTTP 403: Number not whitelisted for trial/.test(err403), err403);
  }

  // ------------------------------------------------------------ calling hours
  const hrs = { tz: 'Asia/Kolkata', start: '09:00', end: '21:00' };
  check('10:00 IST inside', isWithinCallingHours(hrs, new Date('2026-11-16T04:30:00Z')));
  check('08:59 IST outside', !isWithinCallingHours(hrs, new Date('2026-11-16T03:29:00Z')));
  check('21:00 IST outside', !isWithinCallingHours(hrs, new Date('2026-11-16T15:30:00Z')));
  eq('bad tz rejected', validateCallingHours({ tz: 'Nowhere/X', start: '09:00', end: '21:00' }), 'unknown timezone: Nowhere/X');
  eq('end before start rejected', validateCallingHours({ tz: 'UTC', start: '21:00', end: '09:00' }), 'end must be after start');

  // ------------------------------------------------------------ DNC upload
  const dnc = parseDncUpload('phone,name\n+91 98111 22233,Ravi\n09811122233,dup\n12,short\nfoo\n"9876543210",x\n');
  eq('DNC parse dedupes + normalizes', dnc.numbers.sort(), ['+919811122233', '+919876543210']);

  // ------------------------------------------------------------ AI summary: golden transcripts
  const golden: Array<{ name: string; transcript: string; reply: object; expectDate: string | null }> = [
    {
      name: 'interested, follow-up named',
      transcript:
        'Rep: Namaste, this is Anil from Saleinx Furnaces. Customer: Haan, we need a 2 ton induction furnace for the Pune plant. Price kitna hoga? Rep: I will send the quotation today. Customer: Theek hai, call me next Monday after you send it. We are also talking to Electrotherm.',
      reply: {
        summary: 'Customer needs a 2 ton induction furnace for the Pune plant and asked about price. Rep will send a quotation today. Customer asked for a call next Monday and is also talking to Electrotherm.',
        next_steps: ['Send quotation today', 'Call customer next Monday'],
        sentiment: 'positive',
        objections: [],
        competitor_mentions: ['Electrotherm'],
        suggested_disposition: 'interested',
        follow_up_date: '2026-11-23',
      },
      expectDate: '2026-11-23',
    },
    {
      name: 'not interested, no date',
      transcript: 'Rep: Hello, calling about your enquiry for cranes. Customer: We already bought one last month, not needed now. Please do not call again.',
      reply: {
        summary: 'Customer already bought a crane last month and does not need one now. Asked not to be called again.',
        next_steps: [],
        sentiment: 'negative',
        objections: ['Already purchased'],
        competitor_mentions: [],
        suggested_disposition: 'do_not_call',
        follow_up_date: null,
      },
      expectDate: null,
    },
    {
      name: 'hallucinated date is dropped',
      transcript: 'Rep: Did you get the brochure? Customer: Yes, I will discuss with my boss and get back. Rep: Okay, thank you.',
      reply: {
        summary: 'Customer received the brochure and will discuss with their boss before replying.',
        next_steps: ['Wait for customer to get back after internal discussion'],
        sentiment: 'neutral',
        objections: [],
        competitor_mentions: [],
        suggested_disposition: 'callback',
        follow_up_date: '2026-11-20',
      },
      expectDate: null,
    },
  ];
  for (const g of golden) {
    const parsed = parseCallSummary(JSON.stringify(g.reply));
    check(`golden "${g.name}" validates`, parsed.ok, parsed);
    if (parsed.ok) eq(`golden "${g.name}" follow-up date grounded`, groundFollowUpDate(parsed.value, g.transcript).follow_up_date, g.expectDate);
    check(`golden "${g.name}" prompt carries transcript`, buildCallSummaryUserMessage({ transcript: g.transcript, callDate: new Date('2026-11-16T05:00:00Z'), direction: 'outbound' }).includes(g.transcript));
  }
  eq('schema rejects bad sentiment', parseCallSummary(JSON.stringify({ ...golden[0]!.reply, sentiment: 'happy' })).ok, false);
  eq('schema rejects bad date format', parseCallSummary(JSON.stringify({ ...golden[0]!.reply, follow_up_date: 'next monday' })).ok, false);
  eq('rejects >80 words', parseCallSummary(JSON.stringify({ ...golden[0]!.reply, summary: Array(90).fill('word').join(' ') })).ok, false);

  // Invalid-JSON retry path with an injected model.
  const reply = (text: string): Anthropic.Message =>
    ({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text, citations: null }], usage: {} }) as unknown as Anthropic.Message;
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let n = 0;
  const retryOut = await summarizeCallTranscript({
    transcript: golden[0]!.transcript,
    callDate: new Date('2026-11-16T05:00:00Z'),
    direction: 'outbound',
    create: async (p) => {
      sent.push(JSON.parse(JSON.stringify(p)));
      return reply(n++ === 0 ? '{"summary": "oops"' : JSON.stringify(golden[0]!.reply));
    },
  });
  check('invalid JSON retried once then accepted', retryOut.ok && retryOut.attempts === 2, retryOut);
  check('retry message carries the validation error', JSON.stringify(sent[1]?.messages).includes('did not validate'));
  check('model is claude-sonnet-5-5', sent[0]?.model === 'claude-sonnet-5-5');
  check('only transcript + date sent (no phone numbers)', !JSON.stringify(sent[0]).includes('+91'));
  const giveUp = await summarizeCallTranscript({ transcript: 'x', callDate: new Date(), direction: 'inbound', create: async () => reply('not json') });
  check('two invalid replies → transcript only', !giveUp.ok && giveUp.attempts === 2);

  // ------------------------------------------------------------ provider URL never serialized
  const row = {
    id: 'c1', tenantId: 't1', accountId: 'a1', provider: 'exotel', providerCallId: 'p1', direction: 'outbound', leadId: null, contactId: null, userId: 'u1',
    fromNumber: '+918047181234', toNumber: '+919811122233', fromNumberNormalized: null, toNumberNormalized: null, status: 'completed',
    startedAt: new Date(), answeredAt: new Date(), endedAt: new Date(), durationSec: 60, talkTimeSec: 55,
    recordingUrl: 'https://s3-ap-southeast-1.amazonaws.com/exotelrecordings/SECRET-PROVIDER-URL.mp3',
    recordingStorageKey: 'tenant/t1/calls/SECRET-STORAGE-KEY.mp3', recordingArchivedAt: new Date(),
    disposition: null, dispositionAt: null, notes: null, callbackAt: null, transcript: 'hi', aiSummary: null, aiSummaryStatus: null,
    followUpTaskId: null, campaignId: null, campaignItemId: null, consentPolicyVersion: 'v1', createdBy: 'u1', createdAt: new Date(), updatedAt: new Date(),
  } as CallRow;
  const out = JSON.stringify([serializeCall(row), serializeCall(row, { includeTranscript: true })]);
  check('serialized call has no provider URL', !out.includes('SECRET-PROVIDER-URL') && !out.includes('exotelrecordings'));
  check('serialized call has no storage key', !out.includes('SECRET-STORAGE-KEY') && !out.includes('tenant/t1/calls'));
  check('serialized call says a recording exists', serializeCall(row).hasRecording === true);

  console.log(`telephony selftest: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
