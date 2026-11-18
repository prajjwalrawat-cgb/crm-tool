import { z } from 'zod';

/**
 * Pure guards for the AI "what changed and why" narrative.
 *
 *  - `NarrativeSchema`: the exact JSON shape the model must return.
 *  - `validateNarrativeNumbers`: every number in the output must appear in
 *    the facts packet (rounding to 1 dp allowed). One stray number and the
 *    whole narrative is dropped — "Narrative unavailable" beats a wrong figure.
 *  - `findPii`: the packet sent to the model must carry no emails, phone-like
 *    digit runs, or names. Reps are pseudonymised as "Rep 1…n" before the
 *    packet is built and mapped back to names only after validation.
 */

export const NarrativeSchema = z.object({
  headline: z.string().min(1).max(200),
  whats_up: z.array(z.string().max(300)).max(5),
  whats_down: z.array(z.string().max(300)).max(5),
  likely_drivers: z.array(z.string().max(300)).max(5),
  actions_for_manager: z
    .array(z.object({ action: z.string().min(1).max(300), metric: z.string().min(1).max(60) }))
    .max(3),
  caveats: z.array(z.string().max(300)).max(5),
});
export type Narrative = z.infer<typeof NarrativeSchema>;

/** JSON Schema for structured outputs (kept in step with NarrativeSchema by hand). */
export const NARRATIVE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'whats_up', 'whats_down', 'likely_drivers', 'actions_for_manager', 'caveats'],
  properties: {
    headline: { type: 'string' },
    whats_up: { type: 'array', items: { type: 'string' } },
    whats_down: { type: 'array', items: { type: 'string' } },
    likely_drivers: { type: 'array', items: { type: 'string' } },
    actions_for_manager: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'metric'],
        properties: { action: { type: 'string' }, metric: { type: 'string' } },
      },
    },
    caveats: { type: 'array', items: { type: 'string' } },
  },
} as const;

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

/** Numbers written in free text ("1,240", "-12.5", "3"). */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.match(NUMBER_RE) ?? []) {
    const n = Number(m.replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Every number in the packet, from numeric values and from strings (dates, labels like "Rep 3"). */
export function collectPacketNumbers(packet: unknown): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string') out.push(...extractNumbers(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(packet);
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A number from the output is grounded if some packet number equals it after rounding to 1 dp or to an integer. */
export function isGroundedNumber(n: number, packetNumbers: number[]): boolean {
  const a = Math.abs(n);
  return packetNumbers.some((p) => {
    const b = Math.abs(p);
    return r1(a) === r1(b) || Math.round(b) === a || Math.abs(a - b) < 0.051;
  });
}

export function narrativeStrings(n: Narrative): string[] {
  return [
    n.headline,
    ...n.whats_up,
    ...n.whats_down,
    ...n.likely_drivers,
    ...n.actions_for_manager.flatMap((a) => [a.action, a.metric]),
    ...n.caveats,
  ];
}

export function validateNarrativeNumbers(
  n: Narrative,
  packet: unknown,
): { ok: true } | { ok: false; offending: number[] } {
  const pool = collectPacketNumbers(packet);
  const offending: number[] = [];
  for (const s of narrativeStrings(n)) {
    for (const num of extractNumbers(s)) if (!isGroundedNumber(num, pool)) offending.push(num);
  }
  return offending.length ? { ok: false, offending } : { ok: true };
}

/** Each action must name a metric that is in the packet's movers. */
export function validateActionMetrics(n: Narrative, allowedMetricKeys: string[]): boolean {
  const allowed = new Set(allowedMetricKeys);
  return n.actions_for_manager.every((a) => allowed.has(a.metric));
}

const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;
// 7+ digits in a row, optionally separated by spaces/dashes: a phone number.
const PHONE_RE = /(?:\+?\d[\s-]?){7,}/;

/**
 * Return every PII-looking string in the packet: an email, a phone-like digit
 * run, or any of `knownSensitive` (lead names, contact emails, rep names) as a
 * substring. Empty array = clean.
 */
export function findPii(packet: unknown, knownSensitive: string[] = []): string[] {
  const hits: string[] = [];
  const needles = knownSensitive.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3);
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string') {
      const low = v.toLowerCase();
      // ISO dates/day strings are not phone numbers.
      const withoutDates = v.replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, '');
      if (EMAIL_RE.test(v) || PHONE_RE.test(withoutDates) || needles.some((n) => low.includes(n))) {
        hits.push(`${key}: ${v}`);
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (needles.some((n) => k.toLowerCase().includes(n))) hits.push(`key ${k}`);
        walk(x, key ? `${key}.${k}` : k);
      }
    }
  };
  walk(packet);
  return hits;
}

/** Replace pseudonyms ("Rep 3") with display names after validation. */
export function depseudonymise(n: Narrative, names: Record<string, string>): Narrative {
  const swap = (s: string) => s.replace(/\bRep (\d+)\b/g, (m) => names[m] ?? m);
  return {
    headline: swap(n.headline),
    whats_up: n.whats_up.map(swap),
    whats_down: n.whats_down.map(swap),
    likely_drivers: n.likely_drivers.map(swap),
    actions_for_manager: n.actions_for_manager.map((a) => ({ action: swap(a.action), metric: a.metric })),
    caveats: n.caveats.map(swap),
  };
}
