/**
 * Word error rate for STT evaluation: (substitutions + deletions +
 * insertions) / reference words, on normalised text (lower case, punctuation
 * and "Speaker:" prefixes removed). Works on any script, including Devanagari.
 */

export function normaliseForWer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/^\s*(agent|customer|speaker\s*\d*)\s*:/gim, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function wordErrorRate(reference: string, hypothesis: string): { wer: number; refWords: number; edits: number } {
  const r = normaliseForWer(reference);
  const h = normaliseForWer(hypothesis);
  if (r.length === 0) return { wer: h.length ? 1 : 0, refWords: 0, edits: h.length };
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  const edits = prev[h.length]!;
  return { wer: edits / r.length, refWords: r.length, edits };
}
