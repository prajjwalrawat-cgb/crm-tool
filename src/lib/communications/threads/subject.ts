/**
 * Subject normalization. The threading model uses `subject_normalized`
 * to group replies — that means two messages with subjects
 * `"Re: Pricing question"` and `"Pricing question"` MUST normalize to
 * the same string.
 *
 * Rules (deliberately simple, documented so future writes don't drift):
 *   1. Trim outer whitespace
 *   2. Strip a `Re:` / `Fwd:` / `FW:` prefix, case-insensitive, repeatedly
 *   3. Collapse internal whitespace runs to single spaces
 *   4. Lowercase
 *
 * Out of scope for v1:
 *   - Locale-aware prefix variants ("AW:", "答复:") — added only when
 *     a tenant actually sees them.
 *   - Smart stripping of `[External]` / `[INTERNAL]` markers — those
 *     are tenant-specific and would need configuration.
 */

const PREFIX_RE = /^\s*(re|fwd?|fw|aw)\s*:\s*/i;

export function normalizeSubject(raw: string): string {
  let s = (raw ?? '').trim();
  // Repeatedly strip "Re:", "Fwd:" — covers "Re: Re: Re: ...".
  while (true) {
    const next = s.replace(PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').toLowerCase();
}
