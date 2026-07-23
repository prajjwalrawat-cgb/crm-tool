/**
 * Pure, dependency-free helpers for turning a Gmail message into the fields we
 * store. No network, no DB — unit-testable in isolation. Gmail's message shape
 * is a stable Google API contract, so these are safe to write ahead of the
 * storage layer.
 *
 * Privacy note: we deliberately compute only a SUBJECT and a short SNIPPET.
 * Full bodies and attachments are never returned by anything here.
 */

export type EmailAddress = { email: string; name: string | null };

export type ParsedGmailMessage = {
  externalId: string;
  threadId: string | null;
  subject: string;
  snippet: string;
  /** ms since epoch (Gmail internalDate). */
  timestamp: number;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
};

const SNIPPET_MAX = 200;

/**
 * Parse an RFC 5322 address-list header value into structured addresses.
 * Handles `Name <a@b.com>, "Last, First" <c@d.com>, e@f.com`.
 */
export function parseAddressList(value: string | null | undefined): EmailAddress[] {
  if (!value) return [];
  const out: EmailAddress[] = [];
  // Split on commas that are NOT inside quotes (display names may contain commas).
  const parts = splitTopLevel(value, ',');
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*?)<([^>]+)>\s*$/);
    if (angle) {
      const name = cleanName(angle[1]!);
      const email = angle[2]!.trim().toLowerCase();
      if (email) out.push({ email, name: name || null });
    } else {
      const email = part.replace(/^[<"']+|[>"']+$/g, '').trim().toLowerCase();
      if (email.includes('@')) out.push({ email, name: null });
    }
  }
  return out;
}

function splitTopLevel(value: string, sep: string): string[] {
  const res: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === sep && !inQuotes) {
      res.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) res.push(cur);
  return res;
}

function cleanName(raw: string): string {
  return raw.trim().replace(/^"+|"+$/g, '').trim();
}

/** Domain of an email address (lowercased), or null. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d || null;
}

/**
 * Outbound if the mailbox owner is a sender; otherwise inbound. Gmail returns
 * the rep's own address in `from` for messages they sent.
 */
export function determineDirection(
  from: EmailAddress[],
  mailboxEmail: string,
): 'inbound' | 'outbound' {
  const me = mailboxEmail.trim().toLowerCase();
  return from.some((a) => a.email === me) ? 'outbound' : 'inbound';
}

/**
 * Counterparty addresses on a message: everyone in from/to/cc EXCEPT the
 * mailbox owner and any address whose domain is in the workspace's own-domain
 * list or the user's exclusion list, and any explicitly excluded address.
 * Deduplicated, lowercased.
 */
export function counterpartyAddresses(
  msg: Pick<ParsedGmailMessage, 'from' | 'to' | 'cc'>,
  opts: {
    mailboxEmail: string;
    excludedDomains: string[];
    excludedAddresses: string[];
  },
): string[] {
  const me = opts.mailboxEmail.trim().toLowerCase();
  const exDomains = new Set(opts.excludedDomains.map((d) => d.trim().toLowerCase()));
  const exAddrs = new Set(opts.excludedAddresses.map((a) => a.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of [...msg.from, ...msg.to, ...msg.cc]) {
    const email = a.email;
    if (!email || email === me) continue;
    if (exAddrs.has(email)) continue;
    const dom = domainOf(email);
    if (dom && exDomains.has(dom)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Build a ≤200-char snippet from a plaintext body: strip quoted reply chains
 * and signatures-ish trailers, collapse whitespace, take the leading portion.
 */
export function buildSnippet(body: string | null | undefined): string {
  if (!body) return '';
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // Stop at common quoted-reply / forwarded markers.
    if (/^>/.test(t)) break;
    if (/^On .+ wrote:$/i.test(t)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break; // Outlook divider
    if (/^From:\s.+@/i.test(t) && kept.length > 0) break;
    kept.push(line);
  }
  const collapsed = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SNIPPET_MAX) return collapsed;
  return `${collapsed.slice(0, SNIPPET_MAX - 1).trimEnd()}…`;
}

/** Find a header value case-insensitively from Gmail's `payload.headers`. */
export function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? '').toLowerCase() === lower) return h.value ?? null;
  }
  return null;
}
