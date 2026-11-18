import { normalizePhone } from '@/lib/lead-capture/normalize';

/** Parse a DNC upload: one number per line or a CSV whose first phone-like cell per row is used. */
export function parseDncUpload(text: string): { numbers: string[]; invalid: number } {
  const out = new Set<string>();
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const cell = cells.find((c) => /\d{6,}/.test(c.replace(/\D/g, '')));
    if (!cell) continue;
    const n = normalizePhone(cell);
    if (n) out.add(n);
    else invalid++;
  }
  return { numbers: [...out], invalid };
}
